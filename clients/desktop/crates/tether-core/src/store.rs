use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde::de::DeserializeOwned;

pub struct DataDir {
    root: PathBuf,
}

impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The per-user data folder: `%LOCALAPPDATA%\Tether` on Windows, `$XDG_DATA_HOME/tether`
    /// on Linux. Local, not roaming: the secrets the records point at cannot roam with them.
    pub fn default_location() -> io::Result<Self> {
        let dir = Self::new(default_root()?);
        fs::create_dir_all(dir.root())?;
        Ok(dir)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A missing file is a fresh install. Any other read error is retried, and if it still
    /// fails the error is returned so a later save cannot replace a file we never read.
    /// A file that does not parse is moved aside first; if that rename fails, the error is
    /// returned and the original stays where a save would overwrite it.
    pub fn load<T: DeserializeOwned + Default>(&self, file: &str) -> io::Result<T> {
        let path = self.root.join(file);
        let bytes = match read_retry(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
            Err(e) => {
                return Err(io::Error::new(e.kind(), format!("{file}: {e}")));
            }
        };
        match serde_json::from_slice(&bytes) {
            Ok(value) => Ok(value),
            Err(parse) => {
                let aside = self.root.join(format!("{file}.corrupt-{}", unix_now()));
                fs::rename(&path, aside).map_err(|err| {
                    io::Error::new(
                        err.kind(),
                        format!("quarantine {file}: {err}; parse: {parse}"),
                    )
                })?;
                Ok(T::default())
            }
        }
    }

    pub fn save<T: Serialize>(&self, file: &str, value: &T) -> io::Result<()> {
        let json = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
        write_atomic(&self.root.join(file), &json)
    }
}

#[cfg(windows)]
fn default_root() -> io::Result<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is not set"))?;
    Ok(PathBuf::from(base).join("Tether"))
}

#[cfg(not(windows))]
fn default_root() -> io::Result<PathBuf> {
    xdg_dir(
        std::env::var_os("XDG_DATA_HOME").as_deref().map(Path::new),
        std::env::var_os("HOME").as_deref().map(Path::new),
        ".local/share",
    )
    .map(|base| base.join("tether"))
    .ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "neither XDG_DATA_HOME nor HOME is set",
        )
    })
}

/// An XDG base directory: the variable when it is an absolute path (the spec says to ignore a
/// relative one), else `fallback` under home.
pub fn xdg_dir(var: Option<&Path>, home: Option<&Path>, fallback: &str) -> Option<PathBuf> {
    match var {
        Some(dir) if dir.is_absolute() => Some(dir.to_path_buf()),
        _ => home
            .filter(|h| !h.as_os_str().is_empty())
            .map(|h| h.join(fallback)),
    }
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = dir.join(tmp_name);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // std's rename replaces the target on Windows (MOVEFILE_REPLACE_EXISTING).
    fs::rename(&tmp, path)
}

/// First read, then three more about 50 ms apart. NotFound is returned immediately.
fn read_retry(path: &Path) -> io::Result<Vec<u8>> {
    let mut last = None;
    for attempt in 0..4 {
        match fs::read(path) {
            Ok(bytes) => return Ok(bytes),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(e),
            Err(e) => {
                last = Some(e);
                if attempt < 3 {
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("read failed")))
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn xdg_dir_prefers_an_absolute_variable_over_home() {
        let home = Some(Path::new("/home/u"));
        let rel = ".local/share";
        assert_eq!(
            xdg_dir(Some(Path::new("/data")), home, rel),
            Some(PathBuf::from("/data"))
        );
        assert_eq!(
            xdg_dir(None, home, rel),
            Some(PathBuf::from("/home/u/.local/share"))
        );
        assert_eq!(
            xdg_dir(Some(Path::new("relative")), home, rel),
            Some(PathBuf::from("/home/u/.local/share"))
        );
        assert_eq!(xdg_dir(Some(Path::new("")), None, rel), None);
        assert_eq!(xdg_dir(None, Some(Path::new("")), rel), None);
    }

    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Doc {
        items: Vec<String>,
    }

    fn doc(items: &[&str]) -> Doc {
        Doc {
            items: items.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn missing_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        assert_eq!(data.load::<Doc>("profiles.json").unwrap(), Doc::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path().join("Tether"));
        data.save("profiles.json", &doc(&["devbox"])).unwrap();
        assert_eq!(data.load::<Doc>("profiles.json").unwrap(), doc(&["devbox"]));
    }

    #[test]
    fn save_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        data.save("profiles.json", &doc(&["a"])).unwrap();
        data.save("profiles.json", &doc(&["b"])).unwrap();
        assert_eq!(data.load::<Doc>("profiles.json").unwrap(), doc(&["b"]));
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["profiles.json".to_string()]);
    }

    #[test]
    fn corrupt_file_is_quarantined_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let original = b"{\"items\": [\"devbox\", ";
        std::fs::write(dir.path().join("profiles.json"), original).unwrap();

        assert_eq!(data.load::<Doc>("profiles.json").unwrap(), Doc::default());
        data.save("profiles.json", &doc(&["new"])).unwrap();

        let quarantined: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("profiles.json.corrupt-")
            })
            .collect();
        assert_eq!(quarantined.len(), 1);
        assert_eq!(std::fs::read(&quarantined[0]).unwrap(), original);
        assert_eq!(data.load::<Doc>("profiles.json").unwrap(), doc(&["new"]));
    }

    #[test]
    fn unreadable_file_returns_err_and_leaves_it_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let path = dir.path().join("profiles.json");
        std::fs::create_dir(&path).unwrap();

        let err = data.load::<Doc>("profiles.json").unwrap_err();
        assert_ne!(err.kind(), io::ErrorKind::NotFound);
        assert!(path.is_dir());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["profiles.json".to_string()]);
    }
}
