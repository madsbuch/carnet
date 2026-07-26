use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

const IGNORED: &[&str] = &["node_modules", ".git", ".obsidian", ".dropbox.cache"];

#[derive(Serialize)]
pub struct Note {
    path: String,
    content: String,
    mtime: u64,
}

/// Path + mtime only. The client keeps note bodies cached and re-reads just the
/// ones whose mtime moved, so regaining focus over a 10k-note vault costs one
/// walk instead of re-shipping every byte.
#[derive(Serialize)]
pub struct NoteMeta {
    path: String,
    mtime: u64,
}

#[derive(Serialize, Debug)]
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
///
/// Reading lossily is safe. *Writing* what was read lossily is not — the
/// replacement characters would replace the original bytes for good — so
/// `write_note` refuses any file that fails `is_valid_utf8`.
fn read_text(p: &Path) -> Result<String, String> {
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(normalize_eol(&String::from_utf8_lossy(&bytes)))
}

/// Everything above the filesystem works in "\n". A file that uses CRLF keeps
/// it: the content is normalized on the way in and restored on the way out, so
/// editing one block can't leave a note with mixed endings.
fn normalize_eol(s: &str) -> String {
    if s.contains('\r') {
        s.replace("\r\n", "\n")
    } else {
        s.to_string()
    }
}

/// djb2-xor over UTF-8 bytes, hex-encoded — MUST stay identical to
/// contentHash() in src/links.ts. 64-bit: this is the authoritative
/// "did the file change under us" check, and a collision means silently
/// overwriting the other device's edit.
fn djb2(s: &str) -> String {
    let mut h: u64 = 5381;
    for b in s.bytes() {
        h = h.wrapping_mul(33) ^ (b as u64);
    }
    format!("{h:016x}")
}

/// Monotonic suffix for temp files, so two writers on the same note never share
/// a temp path (a user save and a Dropbox mirror write can land together —
/// user saves are serialized in the client, mirror writes are not).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Replace `abs`'s contents atomically *and durably*: write a private temp file,
/// fsync it so the bytes are on the device before anything points at them,
/// rename over the target, then fsync the directory so the rename itself
/// survives. Without the first fsync a power cut can leave the rename durable
/// and the data not — a 0-byte note where a real one was.
fn write_atomic(abs: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "invalid file name".to_string())?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = abs.with_file_name(format!(".{file_name}.{seq}.carnet-tmp"));

    let write = (|| -> std::io::Result<()> {
        let mut f = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = write {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = fs::rename(&tmp, abs) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    // Best effort: some filesystems (and Android's shared-storage shim) don't
    // allow opening a directory. The data fsync above is the load-bearing one.
    if let Some(dir) = abs.parent() {
        let _ = File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

/// A temp file this old can only be debris from a crash mid-write: a live one
/// exists for milliseconds. Sweeping them keeps a crash from leaving litter in
/// the user's Dropbox folder forever.
const TMP_STALE_MS: u64 = 5 * 60 * 1000;

fn sweep_stale_tmp(e: &fs::DirEntry, name: &str) {
    if !name.ends_with(".carnet-tmp") {
        return;
    }
    let path = e.path();
    let Ok(age) = mtime_ms(&path) else { return };
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if now.saturating_sub(age) > TMP_STALE_MS {
        let _ = fs::remove_file(&path);
    }
}

fn walk(dir: &Path, rel: String, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || IGNORED.contains(&name.as_str()) {
            sweep_stale_tmp(&e, &name);
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

/// Path + mtime for every note. Cheap enough to run on every window focus:
/// the client diffs it against what it has cached and re-reads only the notes
/// that actually moved, instead of shipping the whole vault again.
#[tauri::command]
async fn list_notes_meta(root: String) -> Result<Vec<NoteMeta>, String> {
    let mut out = Vec::new();
    for p in list_notes_impl(&root)? {
        let abs = safe_join(&root, &p)?;
        out.push(NoteMeta { path: p, mtime: mtime_ms(&abs).unwrap_or(0) });
    }
    Ok(out)
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
    write_note_impl(&root, &path, content, base_mtime, base_hash)
}

fn write_note_impl(
    root: &str,
    path: &str,
    content: String,
    base_mtime: Option<u64>,
    base_hash: Option<String>,
) -> Result<SaveResult, String> {
    if !path.to_lowercase().ends_with(".md") {
        return Err("only .md files can be written".into());
    }
    let abs = safe_join(root, path)?;
    let mut crlf = false;
    if abs.is_file() {
        // One read answers all three questions below — the UTF-8 check, the
        // line endings, and the change check.
        let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
        // The client only ever holds a lossy decode of a non-UTF-8 file, so
        // writing it back would swap the original bytes for U+FFFD, for good.
        // Refuse instead: the note stays readable, just not editable.
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return Err(format!("{path} is not valid UTF-8 — refusing to overwrite it"));
        };
        crlf = bytes.windows(2).any(|w| w == b"\r\n");
        let disk = normalize_eol(text);
        if let Some(hash) = &base_hash {
            if djb2(&disk) != *hash {
                let mtime = mtime_ms(&abs)?;
                return Ok(SaveResult::Conflict { content: disk, mtime });
            }
        } else if let Some(base) = base_mtime {
            let current = mtime_ms(&abs)?;
            if current.abs_diff(base) > 1 {
                return Ok(SaveResult::Conflict { content: disk, mtime: current });
            }
        }
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let out = if crlf { content.replace('\n', "\r\n") } else { content };
    write_atomic(&abs, out.as_bytes())?;
    Ok(SaveResult::Ok { mtime: mtime_ms(&abs)? })
}

/// Delete a note from the vault. Used by the real-time Dropbox backend to
/// mirror a remote deletion locally. Missing files are a no-op so applying the
/// same delta twice is harmless.
#[tauri::command]
async fn delete_note(root: String, path: String) -> Result<(), String> {
    if !path.to_lowercase().ends_with(".md") {
        return Err("only .md files can be deleted".into());
    }
    let abs = safe_join(&root, &path)?;
    match fs::remove_file(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Let the webview load images from inside this folder, and nowhere else.
///
/// Notes reference images by relative path, so the asset protocol has to be
/// able to read the vault. It used to be configured with `allow: ["**"]`, which
/// let a note pull in any file on the machine; the vault is only known at
/// runtime, so the grant belongs here rather than in tauri.conf.json.
#[tauri::command]
async fn allow_asset_dir(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let path = Path::new(&root);
    if !path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    tauri::Manager::asset_protocol_scope(&app)
        .allow_directory(path, true)
        .map_err(|e| e.to_string())
}

/// Make sure a directory exists, creating it (and parents) if needed. The
/// Dropbox mirror lives in app-local data, which may not exist on first run.
#[tauri::command]
async fn ensure_dir(root: String) -> Result<(), String> {
    fs::create_dir_all(&root).map_err(|e| e.to_string())
}

/// Path of a small state blob in the app's own data directory. `name` is a
/// bare file name — no separators, no "..", so this can't address anything
/// outside that directory.
fn state_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !ok {
        return Err(format!("bad state name: {name}"));
    }
    let dir = tauri::Manager::path(app)
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Read a state blob written by `write_state`. Missing file -> None.
#[tauri::command]
async fn read_state(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let path = state_path(&app, &name)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Persist (or, with `content: null`, delete) a state blob. This is where
/// anything that has to outlive the webview goes — the vault path and the
/// Dropbox credentials. localStorage is not that place on Android: the
/// system can drop web storage when the app is backgrounded or restarted,
/// which is exactly what happens during the Dropbox browser round-trip.
#[tauri::command]
async fn write_state(
    app: tauri::AppHandle,
    name: String,
    content: Option<String>,
) -> Result<(), String> {
    let path = state_path(&app, &name)?;
    let Some(content) = content else {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Atomic + durable, same as notes: this blob holds the vault path, the
    // Dropbox tokens and the whole rev map. A torn write loses the revs, and a
    // lost rev is what turns the next save into a blind overwrite.
    write_atomic(&path, content.as_bytes())
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

    /// Status/navigation bar heights in CSS pixels. The webview draws
    /// edge-to-edge on Android and env(safe-area-inset-*) stays 0 there, so
    /// the UI asks the window directly.
    pub fn safe_area_insets() -> Result<(f64, f64), String> {
        on_android_context(|env, activity| {
            let window = env
                .call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?
                .l()?;
            let decor = env
                .call_method(&window, "getDecorView", "()Landroid/view/View;", &[])?
                .l()?;
            let insets = env
                .call_method(
                    &decor,
                    "getRootWindowInsets",
                    "()Landroid/view/WindowInsets;",
                    &[],
                )?
                .l()?;
            if insets.is_null() {
                return Ok((0.0, 0.0));
            }
            let top = env
                .call_method(&insets, "getSystemWindowInsetTop", "()I", &[])?
                .i()? as f64;
            let bottom = env
                .call_method(&insets, "getSystemWindowInsetBottom", "()I", &[])?
                .i()? as f64;
            let res = env
                .call_method(
                    activity,
                    "getResources",
                    "()Landroid/content/res/Resources;",
                    &[],
                )?
                .l()?;
            let dm = env
                .call_method(
                    &res,
                    "getDisplayMetrics",
                    "()Landroid/util/DisplayMetrics;",
                    &[],
                )?
                .l()?;
            let density = env.get_field(&dm, "density", "F")?.f()? as f64;
            Ok((top / density, bottom / density))
        })
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

#[derive(Serialize)]
pub struct SafeArea {
    top: f64,
    bottom: f64,
}

/// System bar insets in CSS pixels; zero anywhere but Android.
#[tauri::command]
async fn safe_area_insets() -> SafeArea {
    #[cfg(target_os = "android")]
    {
        let (top, bottom) = android::safe_area_insets().unwrap_or((0.0, 0.0));
        return SafeArea { top, bottom };
    }
    #[cfg(not(target_os = "android"))]
    SafeArea { top: 0.0, bottom: 0.0 }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch dir that cleans itself up.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("carnet-test-{name}"));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn root(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn read(&self, rel: &str) -> Vec<u8> {
            fs::read(self.0.join(rel)).unwrap()
        }
        fn put(&self, rel: &str, bytes: &[u8]) {
            fs::write(self.0.join(rel), bytes).unwrap();
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(t: &Tmp, rel: &str, content: &str) -> Result<SaveResult, String> {
        write_note_impl(t.root(), rel, content.into(), None, None)
    }

    // These vectors must match contentHash() in src/links.ts — the two are
    // compared across the IPC boundary and a mismatch means every save looks
    // like a conflict. src/links.test.ts asserts the same values.
    #[test]
    fn hash_vectors_match_the_client() {
        assert_eq!(djb2(""), "0000000000001505");
        assert_eq!(djb2("a"), "000000000002b5c4");
        assert_eq!(djb2("hello"), "000000310a9cede7");
        assert_eq!(djb2("# Note\n\nbody\n"), "d06b5d85825c414c");
        assert_eq!(djb2("Grüße 👋"), "b3bfb38026e3c3c3");
        assert_eq!(djb2("x").len(), 16, "64-bit, not 32");
    }

    #[test]
    fn refuses_to_overwrite_a_file_that_is_not_utf8() {
        let t = Tmp::new("utf8");
        // "# T" then two bytes that are not valid UTF-8
        t.put("bad.md", &[0x23, 0x20, 0x54, 0xff, 0xfe, 0x0a]);
        let before = t.read("bad.md");
        let err = write(&t, "bad.md", "# T\u{fffd}\u{fffd}\n").unwrap_err();
        assert!(err.contains("not valid UTF-8"), "{err}");
        assert_eq!(t.read("bad.md"), before, "the original bytes must survive");
    }

    #[test]
    fn a_crlf_note_stays_crlf_and_never_goes_mixed() {
        let t = Tmp::new("crlf");
        t.put("win.md", b"# Title\r\n\r\nfirst\r\n\r\nsecond\r\n");
        // the client always works in "\n" — it never sees the \r at all
        let read = read_text(&t.0.join("win.md")).unwrap();
        assert_eq!(read, "# Title\n\nfirst\n\nsecond\n");
        // edit one block, exactly as BlockView's splice would
        write(&t, "win.md", "# Title\n\nEDITED\n\nsecond\n").unwrap();
        let bytes = t.read("win.md");
        assert_eq!(bytes, b"# Title\r\n\r\nEDITED\r\n\r\nsecond\r\n");
        assert!(
            !String::from_utf8(bytes).unwrap().contains("\n\n\r"),
            "must not end up with mixed endings"
        );
    }

    #[test]
    fn an_lf_note_stays_lf() {
        let t = Tmp::new("lf");
        t.put("unix.md", b"# Title\n\nbody\n");
        write(&t, "unix.md", "# Title\n\nedited\n").unwrap();
        assert_eq!(t.read("unix.md"), b"# Title\n\nedited\n");
    }

    #[test]
    fn writes_leave_no_temp_file_behind() {
        let t = Tmp::new("tmp");
        write(&t, "a.md", "hello").unwrap();
        let leftovers: Vec<_> = fs::read_dir(&t.0)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("carnet-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
        assert_eq!(t.read("a.md"), b"hello");
    }

    #[test]
    fn concurrent_writes_to_one_note_do_not_share_a_temp_path() {
        let t = Tmp::new("race");
        let root = t.root().to_string();
        // A user save and a Dropbox mirror write can land on the same note at
        // the same time; with a shared temp name they spliced each other.
        let hands: Vec<_> = (0..8)
            .map(|i| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let body = format!("{}", "x".repeat(2000 + i));
                    write_note_impl(&root, "hot.md", body.clone(), None, None).unwrap();
                    body
                })
            })
            .collect();
        let bodies: Vec<String> = hands.into_iter().map(|h| h.join().unwrap()).collect();
        let final_body = String::from_utf8(t.read("hot.md")).unwrap();
        // whichever won, the file must be exactly one writer's bytes — never a splice
        assert!(bodies.contains(&final_body), "torn write: len {}", final_body.len());
    }

    #[test]
    fn the_hash_guard_reports_a_conflict_instead_of_overwriting() {
        let t = Tmp::new("conflict");
        t.put("n.md", b"on disk\n");
        let stale = djb2("what the client loaded\n");
        let res = write_note_impl(t.root(), "n.md", "mine\n".into(), None, Some(stale)).unwrap();
        match res {
            SaveResult::Conflict { content, .. } => assert_eq!(content, "on disk\n"),
            SaveResult::Ok { .. } => panic!("silently overwrote a changed file"),
        }
        assert_eq!(t.read("n.md"), b"on disk\n");
        // and the matching hash goes through
        let good = djb2("on disk\n");
        let res = write_note_impl(t.root(), "n.md", "mine\n".into(), None, Some(good)).unwrap();
        assert!(matches!(res, SaveResult::Ok { .. }));
        assert_eq!(t.read("n.md"), b"mine\n");
    }

    #[test]
    fn stale_temp_files_are_swept_but_fresh_ones_are_left_alone() {
        let t = Tmp::new("sweep");
        t.put(".old.md.7.carnet-tmp", b"crash debris");
        t.put(".new.md.8.carnet-tmp", b"in flight");
        let old = t.0.join(".old.md.7.carnet-tmp");
        let long_ago =
            std::time::SystemTime::now() - std::time::Duration::from_secs(TMP_STALE_MS / 1000 + 60);
        filetime_set(&old, long_ago);
        t.put("real.md", b"note");
        let notes = list_notes_impl(t.root()).unwrap();
        assert_eq!(notes, vec!["real.md".to_string()], "temp files are never listed");
        assert!(!old.exists(), "stale debris should be swept");
        assert!(t.0.join(".new.md.8.carnet-tmp").exists(), "a live write must survive");
    }

    fn filetime_set(p: &Path, when: std::time::SystemTime) {
        // no external crate: reopen and rewrite with utimensat via libc-free path
        let secs = when.duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        let out = std::process::Command::new("touch")
            .arg("-d")
            .arg(format!("@{secs}"))
            .arg(p)
            .status();
        assert!(out.map(|s| s.success()).unwrap_or(false), "touch failed");
    }

    #[test]
    fn safe_join_rejects_anything_that_escapes_the_vault() {
        for bad in ["../etc/passwd", "/etc/passwd", "a/../../b", "..", "a/../.."] {
            assert!(safe_join("/vault", bad).is_err(), "{bad} should be rejected");
        }
        assert!(safe_join("/vault", "ok/note.md").is_ok());
        assert!(safe_join("/vault", "./x.md").is_ok());
    }

    #[test]
    fn a_quit_is_deferred_exactly_once() {
        use std::sync::atomic::AtomicBool;
        let flag = AtomicBool::new(false);
        // the first Cmd+Q waits for the flush...
        assert!(should_defer_quit(&flag));
        // ...and nothing after it does, or the app could never be quit
        for _ in 0..5 {
            assert!(!should_defer_quit(&flag));
        }
    }

    #[test]
    fn racing_quit_requests_still_defer_only_once() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let flag = Arc::new(AtomicBool::new(false));
        let hands: Vec<_> = (0..16)
            .map(|_| {
                let flag = Arc::clone(&flag);
                std::thread::spawn(move || should_defer_quit(&flag))
            })
            .collect();
        let deferred = hands.into_iter().filter_map(|h| h.join().ok()).filter(|d| *d).count();
        assert_eq!(deferred, 1, "exactly one quit may be held back");
    }

    #[test]
    fn only_md_files_can_be_written() {
        let t = Tmp::new("ext");
        assert!(write(&t, "notes.txt", "x").is_err());
        assert!(write(&t, "a.md", "x").is_ok());
    }
}

/// The webview says "I've flushed, you can go now". See the ExitRequested
/// handler below.
#[tauri::command]
async fn confirm_exit(app: tauri::AppHandle) {
    app.cleanup_before_exit();
    std::process::exit(0);
}

/// Set once the quit has already been deferred, so the second pass (and the
/// watchdog's own exit) isn't deferred again.
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Should this quit request be held back to let the webview flush?
///
/// Exactly once, and never again — deferring twice would leave the app unable
/// to quit, and deferring zero times would drop whatever hadn't been saved.
/// Extracted from the event handler so that invariant can be tested.
fn should_defer_quit(flag: &std::sync::atomic::AtomicBool) -> bool {
    !flag.swap(true, std::sync::atomic::Ordering::SeqCst)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            vault_exists,
            list_notes,
            list_notes_meta,
            read_note,
            read_all_notes,
            write_note,
            delete_note,
            ensure_dir,
            allow_asset_dir,
            read_state,
            write_state,
            safe_area_insets,
            storage_ready,
            request_storage_access,
            find_vault_candidates,
            confirm_exit
        ])
        .build(tauri::generate_context!())
        .expect("error while running carnet");

    // Closing the window routes through onCloseRequested in the webview, which
    // Tauri awaits — but Cmd+Q doesn't: it terminates the app outright, taking
    // the 800 ms save debounce and any open block editor with it. Defer the
    // quit once, let the webview flush, and let a watchdog force it through if
    // the webview is wedged so the app can always be quit.
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !should_defer_quit(&QUITTING) {
                return;
            }
            api.prevent_exit();
            let _ = tauri::Emitter::emit(handle, "carnet://flush-and-exit", ());
            let watchdog = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2000));
                watchdog.cleanup_before_exit();
                std::process::exit(0);
            });
        }
    });
}
