/// A fixed URL rather than Velopack's GitHub source: that source scans only the ten newest
/// releases, and iOS releases in the same repo would push the Windows one out of view.
pub const FEED_URL: &str =
    "https://github.com/samuelloranger/tether/releases/download/windows-feed";

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateStatus {
    /// Portable zip or dev build: no installer owns the files, so nothing can replace them.
    Unmanaged,
    Checking,
    UpToDate,
    Downloading(String),
    Ready(String),
    Failed,
    InstallFailed,
}

impl UpdateStatus {
    pub fn label(&self) -> String {
        match self {
            Self::Unmanaged => "Portable build, updates not managed".into(),
            Self::Checking => "Checking for updates…".into(),
            Self::UpToDate => "Up to date".into(),
            Self::Downloading(v) => format!("Downloading {v}…"),
            Self::Ready(v) => format!("{v} is ready"),
            Self::Failed => "Couldn't check for updates".into(),
            Self::InstallFailed => "Couldn't install the update".into(),
        }
    }

    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_downloaded_update_offers_a_restart() {
        assert!(UpdateStatus::Ready("0.0.2".into()).is_ready());
        for s in [
            UpdateStatus::Unmanaged,
            UpdateStatus::Checking,
            UpdateStatus::UpToDate,
            UpdateStatus::Downloading("0.0.2".into()),
            UpdateStatus::Failed,
            UpdateStatus::InstallFailed,
        ] {
            assert!(!s.is_ready(), "{s:?}");
        }
    }

    #[test]
    fn labels_name_the_version() {
        assert_eq!(
            UpdateStatus::Ready("0.0.2".into()).label(),
            "0.0.2 is ready"
        );
        assert_eq!(
            UpdateStatus::Downloading("0.0.2".into()).label(),
            "Downloading 0.0.2…"
        );
    }

    #[test]
    fn the_feed_is_a_directory_url() {
        assert!(!FEED_URL.ends_with('/'));
        assert!(FEED_URL.starts_with("https://"));
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::platform::windows::aumid::AUMID;
    use std::sync::{Arc, Mutex};
    use velopack::sources::HttpSource;
    use velopack::{UpdateCheck, UpdateManager, VelopackApp, VelopackAsset};

    /// Must run before anything else: the installer launches the exe with hook arguments and
    /// expects it to exit, and a downloaded update is applied here on the next launch.
    pub fn startup() {
        VelopackApp::build().set_app_user_model_id(AUMID).run();
    }

    #[derive(Clone, Default)]
    pub struct Updater {
        ready: Arc<Mutex<Option<(UpdateManager, VelopackAsset)>>>,
    }

    impl Updater {
        /// Checks once, downloads in the background, and reports each step from that thread.
        pub fn spawn(&self, report: impl Fn(UpdateStatus) + Send + 'static) {
            let ready = self.ready.clone();
            std::thread::spawn(move || {
                let Ok(manager) = UpdateManager::new(HttpSource::new(FEED_URL), None, None) else {
                    report(UpdateStatus::Unmanaged);
                    return;
                };
                report(UpdateStatus::Checking);
                let info = match manager.check_for_updates() {
                    Ok(UpdateCheck::UpdateAvailable(info)) => info,
                    Ok(_) => return report(UpdateStatus::UpToDate),
                    Err(e) => {
                        tracing::warn!("update check failed: {e}");
                        return report(UpdateStatus::Failed);
                    }
                };
                let version = info.TargetFullRelease.Version.clone();
                report(UpdateStatus::Downloading(version.clone()));
                if let Err(e) = manager.download_updates(&info, None) {
                    tracing::warn!("update download failed: {e}");
                    return report(UpdateStatus::Failed);
                }
                *ready.lock().unwrap() = Some((manager, info.TargetFullRelease.clone()));
                report(UpdateStatus::Ready(version));
            });
        }

        /// Starts the updater, which waits for this process to exit before swapping the files
        /// and relaunching. The caller then closes the window the normal way, so placement is
        /// saved and sessions detach.
        pub fn apply_on_exit(&self) -> bool {
            let ready = self.ready.lock().unwrap();
            let Some((manager, asset)) = ready.as_ref() else {
                return false;
            };
            manager
                .wait_exit_then_apply_updates(asset, false, true, Vec::<String>::new())
                .inspect_err(|e| tracing::warn!("update apply failed: {e}"))
                .is_ok()
        }
    }
}
#[cfg(windows)]
pub use win::*;
