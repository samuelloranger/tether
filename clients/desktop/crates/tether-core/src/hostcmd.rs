use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::{Command, Stdio};

/// Variables an AppImage or similar launcher injects so its own binaries find their libraries;
/// a host program started with them can load the wrong ones and fail.
const LAUNCHER_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "GIO_EXTRA_MODULES",
    "GDK_PIXBUF_MODULE_FILE",
    "GSETTINGS_SCHEMA_DIR",
    "QT_PLUGIN_PATH",
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
];

/// `path` without the entries inside the AppImage, which its runtime puts first.
pub fn host_path(path: &OsStr, appdir: Option<&Path>) -> Option<OsString> {
    let appdir = appdir.filter(|d| !d.as_os_str().is_empty())?;
    let kept: Vec<_> = std::env::split_paths(path)
        .filter(|p| !p.starts_with(appdir))
        .collect();
    std::env::join_paths(kept).ok()
}

/// A host program with no stdin and without the launcher's library variables.
pub fn host_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    let appdir = std::env::var_os("APPDIR");
    if let (Some(path), Some(dir)) = (std::env::var_os("PATH"), appdir.as_deref())
        && let Some(host) = host_path(&path, Some(Path::new(dir)))
    {
        cmd.env("PATH", host);
    }
    for var in LAUNCHER_VARS {
        cmd.env_remove(var);
    }
    cmd.stdin(Stdio::null()).stderr(Stdio::null());
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_launchers_library_variables_are_removed_for_the_child() {
        let cmd = host_command("sh");
        let removed = |name: &str| {
            cmd.get_envs()
                .any(|(k, v)| k == std::ffi::OsStr::new(name) && v.is_none())
        };
        assert!(removed("LD_LIBRARY_PATH"));
        assert!(removed("LD_PRELOAD"));
        assert!(removed("APPIMAGE"));
    }

    // Unix paths.
    #[cfg(unix)]
    #[test]
    fn the_appimage_folders_leave_the_path() {
        let path = OsStr::new("/tmp/.mount_x/usr/bin:/usr/local/bin:/usr/bin");
        assert_eq!(
            host_path(path, Some(Path::new("/tmp/.mount_x"))),
            Some(OsString::from("/usr/local/bin:/usr/bin"))
        );
        assert_eq!(host_path(path, None), None);
        assert_eq!(host_path(path, Some(Path::new(""))), None);
    }
}
