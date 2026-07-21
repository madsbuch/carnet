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
            write_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running carnet");
}
