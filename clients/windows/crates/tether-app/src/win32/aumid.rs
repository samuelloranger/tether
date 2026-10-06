pub const AUMID: &str = "Tether.Terminal";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastIdentity {
    Packaged,
    Portable,
}

/// Velopack installs the app as `<root>\current\Tether.exe` next to `<root>\Update.exe`.
pub fn is_installed(exe: &std::path::Path) -> bool {
    let Some(dir) = exe.parent() else {
        return false;
    };
    dir.file_name().is_some_and(|n| n == "current")
        && dir
            .parent()
            .is_some_and(|root| root.join("Update.exe").is_file())
}

pub fn toast_identity(packaged: bool, shortcut_ok: bool) -> Option<ToastIdentity> {
    if packaged {
        Some(ToastIdentity::Packaged)
    } else if shortcut_ok {
        Some(ToastIdentity::Portable)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_comes_from_the_package_or_the_shortcut() {
        assert_eq!(toast_identity(true, false), Some(ToastIdentity::Packaged));
        assert_eq!(toast_identity(false, true), Some(ToastIdentity::Portable));
        assert_eq!(toast_identity(false, false), None);
    }

    #[test]
    fn an_installed_exe_sits_in_current_beside_the_updater() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("current");
        std::fs::create_dir(&current).unwrap();
        let exe = current.join("Tether.exe");
        assert!(!is_installed(&exe));
        std::fs::write(root.path().join("Update.exe"), b"").unwrap();
        assert!(is_installed(&exe));
        assert!(!is_installed(&root.path().join("Tether.exe")));
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };
    use windows::core::{HSTRING, Interface, PCWSTR};

    pub fn is_packaged() -> bool {
        let mut len = 0u32;
        unsafe { GetCurrentPackageFullName(&mut len, None).0 != 15700 }
    }

    pub fn register_portable() -> bool {
        unsafe {
            if SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID)).is_err() {
                return false;
            }
            // The shortcut follows the last exe that ran; a debug build must not take it over,
            // or the Start menu opens the console build.
            if cfg!(debug_assertions) {
                return true;
            }
            let Ok(exe) = std::env::current_exe() else {
                return false;
            };
            // The installer made `Tether.lnk` with the same AUMID and removes it on uninstall; the
            // portable build keeps its own name so it never retargets that one.
            if is_installed(&exe) {
                return true;
            }
            let Some(appdata) = std::env::var_os("APPDATA") else {
                return false;
            };
            let lnk = std::path::Path::new(&appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\Tether (portable).lnk");
            let made = (|| -> windows::core::Result<()> {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&HSTRING::from(exe.as_os_str()))?;
                let store: IPropertyStore = link.cast()?;
                store.SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(AUMID))?;
                store.Commit()?;
                link.cast::<IPersistFile>()?
                    .Save(PCWSTR(HSTRING::from(lnk.as_os_str()).as_ptr()), true)
            })();
            made.is_ok()
        }
    }
}
#[cfg(windows)]
pub use win::*;
