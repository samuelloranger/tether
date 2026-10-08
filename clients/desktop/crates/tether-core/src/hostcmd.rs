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
];

/// A host program with no stdin and without the launcher's library variables.
pub fn host_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
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
    }
}
