pub const AUMID: &str = "Tether.Terminal";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastIdentity {
    Packaged,
    Portable,
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
            let Some(appdata) = std::env::var_os("APPDATA") else {
                return false;
            };
            let lnk = std::path::Path::new(&appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\Tether.lnk");
            let Ok(exe) = std::env::current_exe() else {
                return false;
            };
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
