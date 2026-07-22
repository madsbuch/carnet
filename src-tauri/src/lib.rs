use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const IGNORED: &[&str] = &["node_modules", ".git", ".obsidian", ".dropbox.cache"];

#[derive(Serialize)]
pub struct Note {
    path: String,
    content: String,
    mtime: u64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveResult {
    Ok { mtime: u64 },
    Conflict { content: String, mtime: u64 },
}

/// Join a vault-relative path onto the root, rejecting anything that could
/// escape the vault (absolute paths, ".." components).
fn safe_join(root: &str, rel: &str) -> Result<PathBuf, String> {
    let rp = Path::new(rel);
    if rp.is_absolute() {
        return Err("absolute paths not allowed".into());
    }
    for c in rp.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("invalid path: {rel}")),
        }
    }
    Ok(Path::new(root).join(rp))
}

fn mtime_ms(p: &Path) -> Result<u64, String> {
    let md = fs::metadata(p).map_err(|e| e.to_string())?;
    let t = md.modified().map_err(|e| e.to_string())?;
    Ok(t.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64)
}

/// Read a file as text; invalid UTF-8 becomes replacement characters instead
/// of an error, so the same note behaves identically in open/search/graph.
fn read_text(p: &Path) -> Result<String, String> {
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// djb2-xor over UTF-8 bytes, hex-encoded — MUST stay identical to
/// contentHash() in src/links.ts.
fn djb2(s: &str) -> String {
    let mut h: u32 = 5381;
    for b in s.bytes() {
        h = h.wrapping_mul(33) ^ (b as u32);
    }
    format!("{h:08x}")
}

fn walk(dir: &Path, rel: String, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || IGNORED.contains(&name.as_str()) {
            continue;
        }
        // never follow symlinks: they can cycle or wander outside the vault
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk(&e.path(), format!("{rel}{name}/"), out);
        } else if ft.is_file() && name.to_lowercase().ends_with(".md") {
            out.push(format!("{rel}{name}"));
        }
    }
}

fn list_notes_impl(root: &str) -> Result<Vec<String>, String> {
    if !Path::new(root).is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut out = Vec::new();
    walk(Path::new(root), String::new(), &mut out);
    out.sort();
    Ok(out)
}

// Commands are async so the (potentially slow, Dropbox-backed) filesystem work
// runs on Tauri's thread pool instead of freezing the UI thread.

#[tauri::command]
async fn vault_exists(root: String) -> bool {
    Path::new(&root).is_dir()
}

#[tauri::command]
async fn list_notes(root: String) -> Result<Vec<String>, String> {
    list_notes_impl(&root)
}

#[tauri::command]
async fn read_note(root: String, path: String) -> Result<Option<Note>, String> {
    let abs = safe_join(&root, &path)?;
    if !abs.is_file() {
        return Ok(None);
    }
    let content = read_text(&abs)?;
    let mtime = mtime_ms(&abs)?;
    Ok(Some(Note { path, content, mtime }))
}

/// One IPC round trip for everything — the client builds the link graph and
/// runs full-text search from this.
#[tauri::command]
async fn read_all_notes(root: String) -> Result<Vec<Note>, String> {
    let mut notes = Vec::new();
    for p in list_notes_impl(&root)? {
        let abs = safe_join(&root, &p)?;
        if let Ok(content) = read_text(&abs) {
            let mtime = mtime_ms(&abs).unwrap_or(0);
            notes.push(Note { path: p, content, mtime });
        }
    }
    Ok(notes)
}

/// Save a note. If the file changed on disk since the client loaded it,
/// nothing is written and the disk version is returned so the client can
/// decide. `base_hash` (content hash of what the client loaded) is the
/// authoritative check — it catches Dropbox restoring older revisions and
/// equal-mtime rewrites; `base_mtime` is the fallback when no hash is given.
/// Omitting both forces the write.
#[tauri::command]
async fn write_note(
    root: String,
    path: String,
    content: String,
    base_mtime: Option<u64>,
    base_hash: Option<String>,
) -> Result<SaveResult, String> {
    if !path.to_lowercase().ends_with(".md") {
        return Err("only .md files can be written".into());
    }
    let abs = safe_join(&root, &path)?;
    if abs.is_file() {
        if let Some(hash) = &base_hash {
            let disk = read_text(&abs)?;
            if djb2(&disk) != *hash {
                let mtime = mtime_ms(&abs)?;
                return Ok(SaveResult::Conflict { content: disk, mtime });
            }
        } else if let Some(base) = base_mtime {
            let current = mtime_ms(&abs)?;
            if current.abs_diff(base) > 1 {
                let disk = read_text(&abs)?;
                return Ok(SaveResult::Conflict { content: disk, mtime: current });
            }
        }
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // write-then-rename so a crash or a mid-write Dropbox sync never sees a
    // truncated file (rename within one directory is atomic)
    let file_name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "invalid file name".to_string())?;
    let tmp = abs.with_file_name(format!(".{file_name}.carnet-tmp"));
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, &abs) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(SaveResult::Ok { mtime: mtime_ms(&abs)? })
}

/// Android glue for the "All files access" permission the vault needs.
/// Everything JNI runs on the Android main thread via wry's dispatch; a
/// channel hands the result back to the (async) command thread.
#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JObject, JString, JValue};
    use jni::JNIEnv;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri_runtime_wry::wry::prelude::dispatch;

    fn on_android_context<T: Send + 'static>(
        f: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        dispatch(move |env, activity, _webview| {
            let out = f(env, activity);
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
            }
            let _ = tx.send(out);
        });
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }

    /// True when Carnet can read shared storage: "All files access" on
    /// API 30+, plain filesystem probe on older versions (where the
    /// manifest permissions alone are enough).
    pub fn storage_ready() -> bool {
        on_android_context(|env, _| {
            env.call_static_method(
                "android/os/Environment",
                "isExternalStorageManager",
                "()Z",
                &[],
            )?
            .z()
        })
        .unwrap_or_else(|_| std::fs::read_dir("/storage/emulated/0").is_ok())
    }

    /// Open the system screen where the user flips "All files access" on —
    /// Carnet's own screen when the device resolves it, the global list
    /// otherwise (some OEMs don't handle the per-app intent).
    pub fn open_all_files_settings() -> Result<(), String> {
        on_android_context(|env, activity| {
            let pkg = env
                .call_method(activity, "getPackageName", "()Ljava/lang/String;", &[])?
                .l()?;
            let pkg: String = env.get_string(&JString::from(pkg))?.into();
            let uri_str: JObject = env.new_string(format!("package:{pkg}"))?.into();
            let uri = env
                .call_static_method(
                    "android/net/Uri",
                    "parse",
                    "(Ljava/lang/String;)Landroid/net/Uri;",
                    &[JValue::Object(&uri_str)],
                )?
                .l()?;
            let action: JObject = env
                .new_string("android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION")?
                .into();
            let intent = env.new_object(
                "android/content/Intent",
                "(Ljava/lang/String;Landroid/net/Uri;)V",
                &[JValue::Object(&action), JValue::Object(&uri)],
            )?;
            let per_app = env.call_method(
                activity,
                "startActivity",
                "(Landroid/content/Intent;)V",
                &[JValue::Object(&intent)],
            );
            if per_app.is_err() {
                if env.exception_check()? {
                    env.exception_clear()?;
                }
                let action: JObject = env
                    .new_string("android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION")?
                    .into();
                let intent = env.new_object(
                    "android/content/Intent",
                    "(Ljava/lang/String;)V",
                    &[JValue::Object(&action)],
                )?;
                env.call_method(
                    activity,
                    "startActivity",
                    "(Landroid/content/Intent;)V",
                    &[JValue::Object(&intent)],
                )?;
            }
            Ok(())
        })
    }
}

/// Whether the app is allowed to read the phone's shared storage.
/// Trivially true anywhere but Android.
#[tauri::command]
async fn storage_ready() -> bool {
    #[cfg(target_os = "android")]
    return android::storage_ready();
    #[cfg(not(target_os = "android"))]
    true
}

/// Send the user to the Android settings screen for "All files access".
#[tauri::command]
async fn request_storage_access() -> Result<(), String> {
    #[cfg(target_os = "android")]
    return android::open_all_files_settings();
    #[cfg(not(target_os = "android"))]
    Err("only needed on Android".into())
}

/// Depth-limited, budgeted probe for a markdown file. The budget caps
/// directory entries visited so a huge folder can't stall the setup screen.
fn contains_markdown(dir: &Path, depth: u32, budget: &mut u32) -> bool {
    if depth == 0 {
        return false;
    }
    let Ok(entries) = fs::read_dir(dir) else { return false };
    for e in entries.flatten() {
        *budget += 1;
        if *budget > 2000 {
            return false;
        }
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name.starts_with('.') || IGNORED.contains(&name.as_str()) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_file() && name.ends_with(".md") {
            return true;
        }
        if ft.is_dir() && contains_markdown(&e.path(), depth - 1, budget) {
            return true;
        }
    }
    false
}

/// Folders that plausibly hold the user's synced notes, for the setup screen
/// to offer as one-tap choices. Agnostic to the sync app: any top-level
/// folder on shared storage with markdown inside counts, Dropbox-ish names
/// first. Empty off Android (the base path can't exist elsewhere).
#[tauri::command]
async fn find_vault_candidates() -> Vec<String> {
    // media/system folders that can be huge and never hold notes
    const SKIP: &[&str] = &[
        "Android", "DCIM", "Pictures", "Movies", "Music", "Ringtones", "Alarms",
        "Notifications", "Podcasts", "Audiobooks", "Recordings",
    ];
    let base = Path::new("/storage/emulated/0");
    let Ok(entries) = fs::read_dir(base) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) || !e.path().is_dir() {
            continue;
        }
        if contains_markdown(&e.path(), 3, &mut 0) {
            out.push(e.path().to_string_lossy().into_owned());
        }
    }
    // "Dropbox"/"Dropsync" and friends before e.g. "Documents"
    out.sort_by_key(|p| (!p.to_lowercase().contains("drop"), p.clone()));
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            vault_exists,
            list_notes,
            read_note,
            read_all_notes,
            write_note,
            storage_ready,
            request_storage_access,
            find_vault_candidates
        ])
        .run(tauri::generate_context!())
        .expect("error while running carnet");
}
