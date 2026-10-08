use std::sync::mpsc::channel;
use std::time::Duration;

use zbus::zvariant::OwnedValue;

/// The portal is asked on a thread: without one the call can wait for service activation.
const PORTAL_TIMEOUT: Duration = Duration::from_millis(500);

pub fn show_error_box(message: &str) {
    eprintln!("Tether: {message}");
    // rfd's portal backend has no message dialog and runs `zenity`; without it only stderr shows the error.
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Tether")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// `org.freedesktop.appearance color-scheme`: 1 prefers dark, 2 prefers light, 0 has no preference.
pub fn scheme_is_light(value: u32) -> bool {
    value == 2
}

fn read_scheme() -> Option<u32> {
    let conn = super::bus::session().ok()?;
    let args = ("org.freedesktop.appearance", "color-scheme");
    let call = |method| {
        conn.call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.portal.Settings"),
            method,
            &args,
        )
        .ok()
    };
    let reply = call("ReadOne").or_else(|| call("Read"))?;
    let value: OwnedValue = reply.body().deserialize().ok()?;
    scheme_value(&value)
}

/// `Read` wraps the value in a second variant, `ReadOne` does not.
pub fn scheme_value(value: &OwnedValue) -> Option<u32> {
    use zbus::zvariant::Value;
    match &**value {
        Value::U32(n) => Some(*n),
        Value::Value(inner) => match **inner {
            Value::U32(n) => Some(n),
            _ => None,
        },
        _ => None,
    }
}

pub fn system_uses_light() -> bool {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(read_scheme());
    });
    rx.recv_timeout(PORTAL_TIMEOUT)
        .ok()
        .flatten()
        .is_some_and(scheme_is_light)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::Value;

    #[test]
    fn only_the_light_preference_is_light() {
        assert!(!scheme_is_light(0));
        assert!(!scheme_is_light(1));
        assert!(scheme_is_light(2));
        assert!(!scheme_is_light(7));
    }

    #[test]
    fn the_value_is_read_through_one_or_two_variants() {
        let plain = OwnedValue::try_from(Value::U32(2)).unwrap();
        assert_eq!(scheme_value(&plain), Some(2));
        let wrapped = OwnedValue::try_from(Value::Value(Box::new(Value::U32(1)))).unwrap();
        assert_eq!(scheme_value(&wrapped), Some(1));
        let other = OwnedValue::try_from(Value::from("x")).unwrap();
        assert_eq!(scheme_value(&other), None);
    }
}
