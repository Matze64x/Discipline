//! Reading and writing Discipline files: importing one, exporting one, and the backup file.
//!
//! Writes are atomic (temporary file in the same directory, flushed to disk, then renamed), so a
//! crash or a sync tool reading at the wrong moment never sees a half-written file: it has either
//! the old content or the new one.

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::data_dir::DataDir;

/// Writes to the real file when `path` is a symlink, so the link (e.g. into a sync folder) stays.
fn resolve(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn split(path: &Path) -> std::io::Result<(PathBuf, OsString)> {
    let name = path.file_name().ok_or_else(|| std::io::Error::other("not a file path"))?;
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    Ok((dir.to_path_buf(), name.to_owned()))
}

/// Atomically replaces (or creates) the file, keeping an existing file's permissions.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    write_atomic_with(path, contents, false)
}

/// Like `write_atomic`, for a file only this user may read (e.g. one holding a key): on Unix it's
/// readable by the owner only from the start, not just after it was written.
pub fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    write_atomic_with(path, contents, true)
}

fn write_atomic_with(path: &Path, contents: &str, private: bool) -> std::io::Result<()> {
    let path = resolve(path);
    let (dir, name) = split(&path)?;
    // the process id makes the name unique per app instance; the app writes one file at a time
    let tmp = dir.join(format!(".{}.tmp{}", name.to_string_lossy(), std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            // (a leftover temp file keeps its mode: remove it first)
            let _ = fs::remove_file(&tmp);
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if !private && let Ok(metadata) = fs::metadata(&path) {
            fs::set_permissions(&tmp, metadata.permissions())?;
        }
        fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

// Commands run on a worker thread (async), so slow disks don't freeze the window.

#[tauri::command(async)]
pub fn read_file(path: PathBuf) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Can't read {}: {e}", path.display()))
}

#[tauri::command(async)]
pub fn write_file(path: PathBuf, contents: String) -> Result<(), String> {
    write_atomic(&path, &contents).map_err(|e| format!("Can't write {}: {e}", path.display()))
}

#[tauri::command(async)]
pub fn file_exists(path: PathBuf) -> bool {
    path.exists()
}

/// Where the app keeps its own data, and whether that's the portable folder (for the settings).
#[tauri::command]
pub fn data_location(app: AppHandle) -> Option<(PathBuf, bool)> {
    app.try_state::<DataDir>().map(|d| (d.path.clone(), d.portable))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn creates_and_replaces_atomically_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("discipline.json");
        write_atomic(&path, "first").unwrap();
        write_atomic(&path, "second ü€").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second ü€");
        assert_eq!(names(dir.path()), vec!["discipline.json"]);
    }

    #[test]
    fn a_failed_write_leaves_the_file_and_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("discipline.json");
        write_atomic(&path, "kept").unwrap();
        // a directory where the file should go can't be replaced by a rename
        let blocked = dir.path().join("folder.json");
        fs::create_dir(&blocked).unwrap();
        fs::write(blocked.join("inside"), "").unwrap();
        assert!(write_atomic(&blocked, "new").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "kept");
        assert_eq!(names(dir.path()), vec!["discipline.json", "folder.json"]);
    }

    #[test]
    #[cfg(unix)]
    fn keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("discipline.json");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        write_atomic(&path, "new").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    #[cfg(unix)]
    fn writes_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.json");
        let link = dir.path().join("link.json");
        fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, "new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }
}
