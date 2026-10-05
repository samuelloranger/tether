use std::error::Error;
use std::panic::PanicHookInfo;

const DATA_FILES: [&str; 4] = [
    "profiles.json",
    "keys.json",
    "preferences.json",
    "hostkeys.json",
];

/// The text of the startup box. A data-file error names that file.
pub fn startup_message(err: &dyn Error) -> String {
    let mut text = String::new();
    let mut current = Some(err);
    let mut named: Option<&str> = None;
    while let Some(item) = current {
        let display = item.to_string();
        if named.is_none() {
            named = DATA_FILES.into_iter().find(|file| display.contains(file));
        }
        if !text.is_empty() {
            text.push_str(": ");
        }
        text.push_str(&display);
        current = item.source();
    }
    match named {
        Some(file) => format!("Couldn't read {file}.\n\n{text}"),
        None => text,
    }
}

pub fn panic_box_message(info: &PanicHookInfo) -> String {
    info.payload()
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
        .unwrap_or("The application panicked")
        .to_string()
}

/// Installed from `main` in release builds, where there is no console.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        crate::platform::show_error_box(&panic_box_message(info));
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn a_data_file_error_names_the_file() {
        let err = io::Error::new(
            io::ErrorKind::PermissionDenied,
            "profiles.json: Access is denied. (os error 5)",
        );
        let message = startup_message(&err);
        assert!(message.starts_with("Couldn't read profiles.json."));
        assert!(message.contains("Access is denied"));
        assert!(!message.contains("keys.json"));
    }

    #[test]
    fn a_slint_or_dpapi_error_keeps_its_own_text() {
        let err = io::Error::other("DPAPI: decryption failed");
        assert_eq!(startup_message(&err), "DPAPI: decryption failed");
    }

    #[test]
    fn a_panic_message_is_the_payload() {
        let (tx, rx) = std::sync::mpsc::channel();
        std::panic::set_hook(Box::new(move |info| {
            let _ = tx.send(panic_box_message(info));
        }));
        let _ = std::panic::catch_unwind(|| panic!("the grid was empty"));
        assert_eq!(rx.try_recv().unwrap(), "the grid was empty");
        let _ = std::panic::take_hook();
    }
}
