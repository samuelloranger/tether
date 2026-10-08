use crate::terminal::model::Msg;

pub const WM_SYSCOMMAND: u32 = 0x0112;
pub const SC_KEYMENU: usize = 0xF100;
pub const WM_SYSCHAR: u32 = 0x0106;
pub const WM_MENUCHAR: u32 = 0x0120;
/// HIWORD of a WM_MENUCHAR result: close the menu without the default beep.
pub const MNC_CLOSE: isize = 1;
pub const WM_POWERBROADCAST: u32 = 0x0218;
pub const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;
pub const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
pub const WTS_SESSION_LOCK: usize = 0x7;
pub const WTS_SESSION_UNLOCK: usize = 0x8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemEvent {
    SwallowKeyMenu,
    /// Alt+letter with no menu to match: DefWindowProc would beep on every key.
    SwallowSysChar,
    /// A key while the window is in menu mode: answered with MNC_CLOSE, not a beep.
    CloseMenuChar,
    Resumed,
    Locked,
    Unlocked,
}

pub fn classify(msg: u32, wparam: usize) -> Option<SystemEvent> {
    match msg {
        WM_SYSCOMMAND if wparam & 0xFFF0 == SC_KEYMENU => Some(SystemEvent::SwallowKeyMenu),
        // Alt+Space still opens the window menu.
        WM_SYSCHAR if wparam != 0x20 => Some(SystemEvent::SwallowSysChar),
        WM_MENUCHAR => Some(SystemEvent::CloseMenuChar),
        WM_POWERBROADCAST if wparam == PBT_APMRESUMEAUTOMATIC => Some(SystemEvent::Resumed),
        WM_WTSSESSION_CHANGE if wparam == WTS_SESSION_LOCK => Some(SystemEvent::Locked),
        WM_WTSSESSION_CHANGE if wparam == WTS_SESSION_UNLOCK => Some(SystemEvent::Unlocked),
        _ => None,
    }
}

pub fn to_msg(ev: SystemEvent) -> Option<Msg> {
    match ev {
        SystemEvent::SwallowKeyMenu | SystemEvent::SwallowSysChar | SystemEvent::CloseMenuChar => {
            None
        }
        SystemEvent::Resumed => Some(Msg::Resumed),
        SystemEvent::Locked => Some(Msg::Locked),
        SystemEvent::Unlocked => Some(Msg::Unlocked),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keymenu_is_swallowed_whatever_its_low_bits() {
        assert_eq!(
            classify(WM_SYSCOMMAND, SC_KEYMENU),
            Some(SystemEvent::SwallowKeyMenu)
        );
        assert_eq!(
            classify(WM_SYSCOMMAND, SC_KEYMENU | 0x2),
            Some(SystemEvent::SwallowKeyMenu)
        );
        assert_eq!(classify(WM_SYSCOMMAND, 0xF060), None);
        assert_eq!(classify(WM_SYSCOMMAND, 0xF020), None);
    }

    #[test]
    fn keys_that_would_beep_are_swallowed() {
        assert_eq!(
            classify(WM_SYSCHAR, b'a' as usize),
            Some(SystemEvent::SwallowSysChar)
        );
        assert_eq!(classify(WM_SYSCHAR, 0x20), None);
        assert_eq!(
            classify(WM_MENUCHAR, b'x' as usize),
            Some(SystemEvent::CloseMenuChar)
        );
        assert!(to_msg(SystemEvent::SwallowSysChar).is_none());
    }

    #[test]
    fn resume_lock_and_unlock_become_messages() {
        assert!(matches!(
            classify(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC).and_then(to_msg),
            Some(Msg::Resumed)
        ));
        assert!(matches!(
            classify(WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK).and_then(to_msg),
            Some(Msg::Locked)
        ));
        assert!(matches!(
            classify(WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK).and_then(to_msg),
            Some(Msg::Unlocked)
        ));
        assert_eq!(classify(WM_POWERBROADCAST, 0x0004), None);
        assert_eq!(classify(WM_WTSSESSION_CHANGE, 0x1), None);
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::RemoteDesktop::{
        NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match classify(msg, wparam.0) {
            Some(SystemEvent::SwallowKeyMenu | SystemEvent::SwallowSysChar) => return LRESULT(0),
            Some(SystemEvent::CloseMenuChar) => return LRESULT(MNC_CLOSE << 16),
            Some(ev) => {
                if let Some(m) = to_msg(ev) {
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(s) = crate::terminal::glue::current() {
                            s(m);
                        }
                    });
                }
            }
            None => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    pub fn install(hwnd: isize) {
        let hwnd = HWND(hwnd as _);
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 0x7E7E, 0);
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        }
    }
}
#[cfg(windows)]
pub use win::install;
