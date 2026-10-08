/// A fixed URL rather than Velopack's GitHub source: that source scans only the ten newest
/// releases, and iOS releases in the same repo would push the desktop ones out of view.
/// Each OS reads its own rolling feed release.
#[cfg(windows)]
pub const FEED_URL: &str =
    "https://github.com/samuelloranger/tether/releases/download/windows-feed";
#[cfg(not(windows))]
pub const FEED_URL: &str = "https://github.com/samuelloranger/tether/releases/download/linux-feed";

/// Debug builds read `TETHER_UPDATE_FEED` so an update can be tried against a local feed.
/// Release builds never do: the feed decides what code gets installed.
#[cfg(any(windows, target_os = "linux"))]
fn feed_url() -> String {
    feed_url_with(
        cfg!(debug_assertions),
        std::env::var("TETHER_UPDATE_FEED").ok(),
    )
}

fn feed_url_with(debug: bool, over: Option<String>) -> String {
    match over {
        Some(url) if debug && !url.is_empty() => url.trim_end_matches('/').to_string(),
        _ => FEED_URL.to_string(),
    }
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateStatus {
    /// Portable zip, unpacked binary or dev build: no installer owns the files, so nothing can
    /// replace them.
    Unmanaged,
    Checking,
    UpToDate,
    Downloading(String),
    Ready(String),
    Failed,
    InstallFailed,
}

#[cfg(windows)]
const UNMANAGED_LABEL: &str = "Portable build, updates not managed";
#[cfg(not(windows))]
const UNMANAGED_LABEL: &str = "Not running from the AppImage, updates not managed";

impl UpdateStatus {
    pub fn label(&self) -> String {
        match self {
            Self::Unmanaged => UNMANAGED_LABEL.into(),
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

    #[test]
    fn each_os_reads_its_own_feed() {
        let feed = if cfg!(windows) {
            "windows-feed"
        } else {
            "linux-feed"
        };
        assert!(FEED_URL.ends_with(&format!("/releases/download/{feed}")));
    }

    #[test]
    fn only_debug_builds_honour_a_feed_override() {
        let local = Some("http://127.0.0.1:8000/".to_string());
        assert_eq!(feed_url_with(true, local.clone()), "http://127.0.0.1:8000");
        assert_eq!(feed_url_with(false, local), FEED_URL);
        assert_eq!(feed_url_with(true, Some(String::new())), FEED_URL);
        assert_eq!(feed_url_with(true, None), FEED_URL);
    }
}

/// Velopack's own Linux default is `/var/tmp/velopack/<id>/packages`: shared between users,
/// and every launch installs any newer package found there. Both the startup hook and the
/// updater are pointed at a private folder instead, and an AppImage that cannot get one is
/// left unmanaged.
#[cfg(target_os = "linux")]
mod private {
    use std::fs;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use velopack::locator::VelopackLocatorConfig;

    pub fn locator() -> Option<VelopackLocatorConfig> {
        let exe = std::env::current_exe().ok()?;
        let appimage = PathBuf::from(std::env::var_os("APPIMAGE").filter(|v| !v.is_empty())?);
        let packages = packages_dir(
            std::env::var_os("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .as_deref(),
            std::env::var_os("HOME").map(PathBuf::from).as_deref(),
        )?;
        let config = locator_for(&exe, &appimage, packages.clone())?;
        prepare(&packages)
            .inspect_err(|e| tracing::warn!("update folder {}: {e}", packages.display()))
            .ok()?;
        Some(config)
    }

    pub fn packages_dir(cache_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
        tether_core::store::xdg_dir(cache_home, home, ".cache")
            .map(|base| base.join("tether").join("updates"))
    }

    /// The paths Velopack derives for a mounted AppImage, with the packages folder ours.
    pub fn locator_for(
        exe: &Path,
        appimage: &Path,
        packages: PathBuf,
    ) -> Option<VelopackLocatorConfig> {
        let exe = exe.to_string_lossy();
        let mount = &exe[..exe.find("/usr/bin/")?];
        let contents = Path::new(mount).join("usr").join("bin");
        let update = contents.join("UpdateNix");
        let manifest = contents.join("sq.version");
        if !update.is_file() || !manifest.is_file() {
            return None;
        }
        Some(VelopackLocatorConfig {
            RootAppDir: appimage.to_path_buf(),
            UpdateExePath: update,
            PackagesDir: packages,
            ManifestPath: manifest,
            CurrentBinaryDir: contents,
            IsPortable: true,
        })
    }

    /// A real directory owned by this user and closed to everyone else.
    pub fn prepare(dir: &Path) -> std::io::Result<()> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        let meta = fs::symlink_metadata(dir)?;
        let me = fs::metadata("/proc/self")?.uid();
        if !meta.is_dir() || meta.uid() != me {
            return Err(std::io::Error::other("not a directory owned by this user"));
        }
        if meta.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_packages_folder_is_per_user_under_the_cache() {
            assert_eq!(
                packages_dir(Some(Path::new("/c")), Some(Path::new("/home/u"))),
                Some(PathBuf::from("/c/tether/updates"))
            );
            assert_eq!(
                packages_dir(None, Some(Path::new("/home/u"))),
                Some(PathBuf::from("/home/u/.cache/tether/updates"))
            );
            assert_eq!(packages_dir(None, None), None);
            assert!(
                !packages_dir(Some(Path::new("/c")), None)
                    .unwrap()
                    .starts_with("/var/tmp")
            );
        }

        #[test]
        fn only_a_mounted_appimage_gets_a_locator() {
            let dir = tempfile::tempdir().unwrap();
            let bin = dir.path().join("usr/bin");
            fs::create_dir_all(&bin).unwrap();
            let exe = bin.join("tether");
            let packages = dir.path().join("pk");
            assert!(locator_for(&exe, Path::new("/a/T.AppImage"), packages.clone()).is_none());
            fs::write(bin.join("UpdateNix"), b"").unwrap();
            fs::write(bin.join("sq.version"), b"").unwrap();
            let cfg = locator_for(&exe, Path::new("/a/T.AppImage"), packages.clone()).unwrap();
            assert_eq!(cfg.PackagesDir, packages);
            assert_eq!(cfg.RootAppDir, Path::new("/a/T.AppImage"));
            assert_eq!(cfg.UpdateExePath, bin.join("UpdateNix"));
            assert!(locator_for(Path::new("/opt/tether"), Path::new("/a"), packages).is_none());
        }

        #[test]
        fn the_folder_is_created_private_and_a_loose_one_is_tightened() {
            let dir = tempfile::tempdir().unwrap();
            let target = dir.path().join("a/b/updates");
            prepare(&target).unwrap();
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&target), 0o700);
            fs::set_permissions(&target, fs::Permissions::from_mode(0o777)).unwrap();
            prepare(&target).unwrap();
            assert_eq!(mode(&target), 0o700);
        }

        #[test]
        fn a_symlinked_folder_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let real = dir.path().join("real");
            fs::create_dir(&real).unwrap();
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(prepare(&link).is_err());
        }
    }
}

#[cfg(any(windows, target_os = "linux"))]
mod managed {
    use super::*;
    use std::sync::{Arc, Mutex};
    use velopack::sources::HttpSource;
    use velopack::{UpdateCheck, UpdateManager, VelopackApp, VelopackAsset};

    /// Must run before anything else: the installer launches the exe with hook arguments and
    /// expects it to exit, and a downloaded update is applied here on the next launch. Outside
    /// a Velopack package (a dev build, an unpacked AppImage) it does nothing.
    pub fn startup() {
        let mut app = VelopackApp::build();
        #[cfg(windows)]
        {
            app = app.set_app_user_model_id(crate::platform::windows::aumid::AUMID);
        }
        #[cfg(target_os = "linux")]
        {
            let Some(locator) = private::locator() else {
                return;
            };
            app = app.set_locator(locator);
        }
        app.run();
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
                #[cfg(target_os = "linux")]
                let locator = private::locator();
                #[cfg(target_os = "linux")]
                if locator.is_none() {
                    return report(UpdateStatus::Unmanaged);
                }
                #[cfg(windows)]
                let locator = None;
                let Ok(manager) = UpdateManager::new(HttpSource::new(feed_url()), None, locator)
                else {
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
#[cfg(any(windows, target_os = "linux"))]
pub use managed::*;
