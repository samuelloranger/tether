#[cfg(windows)]
mod win {
    use std::cell::RefCell;
    use std::mem::size_of;
    use tether_core::osc::Progress;
    use tether_core::taskbar::{TaskbarState, taskbar_state};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
    use windows::Win32::UI::Shell::{
        ITaskbarList3, TBPF_ERROR, TBPF_INDETERMINATE, TBPF_NOPROGRESS, TBPF_NORMAL, TBPF_PAUSED,
        TaskbarList,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        FLASHW_TIMERNOFG, FLASHW_TRAY, FLASHWINFO, FlashWindowEx,
    };

    thread_local! {
        static LIST: RefCell<Option<ITaskbarList3>> = const { RefCell::new(None) };
    }

    fn with_list(f: impl FnOnce(&ITaskbarList3)) {
        LIST.with(|l| {
            let mut l = l.borrow_mut();
            if l.is_none() {
                *l = unsafe {
                    CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER)
                }
                .ok()
                .filter(|list| unsafe { list.HrInit() }.is_ok());
            }
            if let Some(list) = l.as_ref() {
                f(list);
            }
        });
    }

    pub fn set_progress(hwnd: isize, p: Option<&Progress>) {
        let (state, value) = taskbar_state(p);
        let flag = match state {
            TaskbarState::NoProgress => TBPF_NOPROGRESS,
            TaskbarState::Normal => TBPF_NORMAL,
            TaskbarState::Error => TBPF_ERROR,
            TaskbarState::Indeterminate => TBPF_INDETERMINATE,
            TaskbarState::Paused => TBPF_PAUSED,
        };
        with_list(|list| unsafe {
            let hwnd = HWND(hwnd as _);
            let _ = list.SetProgressState(hwnd, flag);
            if let Some(v) = value {
                let _ = list.SetProgressValue(hwnd, v, 100);
            }
        });
    }

    pub fn flash(hwnd: isize) {
        let info = FLASHWINFO {
            cbSize: size_of::<FLASHWINFO>() as u32,
            hwnd: HWND(hwnd as _),
            dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG,
            uCount: 0,
            dwTimeout: 0,
        };
        unsafe {
            let _ = FlashWindowEx(&info);
        }
    }
}
#[cfg(windows)]
pub use win::*;
