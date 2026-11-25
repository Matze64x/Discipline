//! Where the app keeps its own data: the webview's storage with the working copy and settings.
//!
//! Normally that's the system's app data directory. A folder named `Discipline-data` next to the
//! program makes it portable: everything goes into that folder instead, so the program and its
//! data can be carried around together (e.g. on a USB stick).

use std::path::{Path, PathBuf};

pub const PORTABLE_DIR: &str = "Discipline-data";

/// The app's data directory, managed as Tauri state.
pub struct DataDir {
    pub path: PathBuf,
    pub portable: bool,
}

impl DataDir {
    /// Only set for the portable version: the installed one keeps the webview's default location.
    pub fn webview(&self) -> Option<PathBuf> {
        self.portable.then(|| self.path.join("webview"))
    }
}

/// The folder the program was started from.
fn program_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// The portable data folder in `dir`, if there is one.
pub fn portable_in(dir: &Path) -> Option<PathBuf> {
    let candidate = dir.join(PORTABLE_DIR);
    candidate.is_dir().then_some(candidate)
}

pub fn resolve(app_data_dir: Option<PathBuf>) -> Option<DataDir> {
    if let Some(path) = program_dir().as_deref().and_then(portable_in) {
        return Some(DataDir { path, portable: true });
    }
    app_data_dir.map(|path| DataDir { path, portable: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_only_with_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(portable_in(dir.path()), None);
        // a file of that name doesn't count
        std::fs::write(dir.path().join(PORTABLE_DIR), "").unwrap();
        assert_eq!(portable_in(dir.path()), None);
        std::fs::remove_file(dir.path().join(PORTABLE_DIR)).unwrap();
        std::fs::create_dir(dir.path().join(PORTABLE_DIR)).unwrap();
        assert_eq!(portable_in(dir.path()), Some(dir.path().join(PORTABLE_DIR)));
    }

    #[test]
    fn installed_keeps_the_default_webview_location() {
        let installed = DataDir { path: "/data".into(), portable: false };
        assert_eq!(installed.webview(), None);
        let portable = DataDir { path: "/stick/Discipline-data".into(), portable: true };
        assert_eq!(portable.webview(), Some(PathBuf::from("/stick/Discipline-data/webview")));
    }
}
