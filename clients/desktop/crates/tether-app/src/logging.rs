use std::path::{Path, PathBuf};

use tether_core::store::xdg_dir;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;

const KEEP_DAYS: usize = 7;

/// `%LOCALAPPDATA%\Tether\logs`, next to the data the app keeps.
pub fn windows_log_dir(local_app_data: Option<&Path>) -> Option<PathBuf> {
    local_app_data.map(|base| base.join("Tether").join("logs"))
}

/// `$XDG_STATE_HOME/tether/logs`: logs are state, not data a backup should carry.
pub fn linux_log_dir(state_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    xdg_dir(state_home, home, ".local/state").map(|base| base.join("tether").join("logs"))
}

fn log_dir() -> Option<PathBuf> {
    let var = |name| std::env::var_os(name);
    if cfg!(windows) {
        windows_log_dir(var("LOCALAPPDATA").as_deref().map(Path::new))
    } else {
        linux_log_dir(
            var("XDG_STATE_HOME").as_deref().map(Path::new),
            var("HOME").as_deref().map(Path::new),
        )
    }
}

pub fn file_appender(dir: &Path) -> Result<RollingFileAppender, Box<dyn std::error::Error>> {
    Ok(RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("tether")
        .filename_suffix("log")
        .max_log_files(KEEP_DAYS)
        .build(dir)?)
}

fn filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
}

/// A release build has no console, so its log goes to a daily file; a debug build, or one
/// without a usable log folder, writes to stderr. Keep the guard until exit: dropping it
/// flushes what is still queued.
pub fn init() -> Option<WorkerGuard> {
    let appender = if cfg!(debug_assertions) {
        None
    } else {
        log_dir().and_then(|dir| file_appender(&dir).ok())
    };
    let Some(appender) = appender else {
        tracing_subscriber::fmt().with_env_filter(filter()).init();
        return None;
    };
    let (writer, guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::fmt()
        .with_env_filter(filter())
        .with_ansi(false)
        .with_writer(writer)
        .init();
    Some(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_live_under_the_app_data_folder() {
        let base = Path::new("local");
        assert_eq!(
            windows_log_dir(Some(base)),
            Some(base.join("Tether").join("logs"))
        );
        assert_eq!(windows_log_dir(None), None);
    }

    #[test]
    fn linux_logs_live_under_the_state_folder() {
        let home = Some(Path::new("/home/u"));
        assert_eq!(
            linux_log_dir(Some(Path::new("/state")), home),
            Some(PathBuf::from("/state/tether/logs"))
        );
        assert_eq!(
            linux_log_dir(None, home),
            Some(PathBuf::from("/home/u/.local/state/tether/logs"))
        );
        assert_eq!(linux_log_dir(None, None), None);
    }

    #[test]
    fn events_land_in_a_dated_file_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let appender = file_appender(&logs).unwrap();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(appender))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("connected to the host");
        });
        let files: Vec<_> = std::fs::read_dir(&logs)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1);
        let name = files[0].file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("tether.") && name.ends_with(".log"),
            "{name}"
        );
        let text = std::fs::read_to_string(&files[0]).unwrap();
        assert!(text.contains("connected to the host"), "{text}");
    }
}
