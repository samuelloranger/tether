use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use zbus::Message;
use zbus::blocking::Connection;
use zbus::zvariant::{ObjectPath, OwnedValue};

use super::bus::{for_each_signal, signal_rule};
use crate::terminal::model::Msg;

const LOGIN: &str = "org.freedesktop.login1";
const MANAGER: &str = "/org/freedesktop/login1";
const MANAGER_IFACE: &str = "org.freedesktop.login1.Manager";
const SESSION_IFACE: &str = "org.freedesktop.login1.Session";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

/// What a logind signal means. `locked` is the last lock state reported, so the `Lock` signal and
/// the `LockedHint` change a desktop's idle lock also sets collapse into one message.
pub fn on_signal(locked: &AtomicBool, msg: &Message) -> Option<Msg> {
    let header = msg.header();
    let body = msg.body();
    match header.member()?.as_str() {
        "PrepareForSleep" => {
            let sleeping: bool = body.deserialize().ok()?;
            (!sleeping).then_some(Msg::Resumed)
        }
        "Lock" => lock_changed(locked, true),
        "Unlock" => lock_changed(locked, false),
        "PropertiesChanged" => {
            let (iface, changed, _): (String, HashMap<String, OwnedValue>, Vec<String>) =
                body.deserialize().ok()?;
            if iface != SESSION_IFACE {
                return None;
            }
            let hint = bool::try_from(changed.get("LockedHint")?).ok()?;
            lock_changed(locked, hint)
        }
        _ => None,
    }
}

fn lock_changed(locked: &AtomicBool, now: bool) -> Option<Msg> {
    if locked.swap(now, Ordering::Relaxed) == now {
        return None;
    }
    Some(if now { Msg::Locked } else { Msg::Unlocked })
}

fn own_session(conn: &Connection) -> Option<ObjectPath<'static>> {
    conn.call_method(
        Some(LOGIN),
        MANAGER,
        Some(MANAGER_IFACE),
        "GetSessionByPID",
        &(std::process::id(),),
    )
    .ok()?
    .body()
    .deserialize::<ObjectPath>()
    .ok()
    .map(|p| p.into_owned())
}

/// Subscribes to logind on the system bus: resume from sleep, and this session's lock and unlock.
/// Only listens; it never calls anything that changes state.
pub fn watch() {
    let spawned = std::thread::Builder::new().name("logind".into()).spawn(|| {
        if let Err(e) = run() {
            tracing::debug!("logind watch stopped: {e}");
        }
    });
    if let Err(e) = spawned {
        tracing::debug!("logind watch failed: {e}");
    }
}

fn run() -> zbus::Result<()> {
    let conn = Connection::system()?;
    let mut rules = vec![signal_rule(
        MANAGER_IFACE,
        "PrepareForSleep",
        Some(MANAGER),
    )?];
    if let Some(session) = own_session(&conn) {
        let path = session.as_str();
        rules.push(signal_rule(SESSION_IFACE, "Lock", Some(path))?);
        rules.push(signal_rule(SESSION_IFACE, "Unlock", Some(path))?);
        rules.push(signal_rule(PROPERTIES, "PropertiesChanged", Some(path))?);
    }
    let locked = AtomicBool::new(false);
    for_each_signal(&conn, rules, |msg| {
        if let Some(m) = on_signal(&locked, msg) {
            super::deliver(m);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal<B>(path: &str, iface: &str, member: &str, body: &B) -> Message
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        Message::signal(path, iface, member)
            .unwrap()
            .build(body)
            .unwrap()
    }

    const SESSION: &str = "/org/freedesktop/login1/session/_32";

    #[test]
    fn waking_from_sleep_resumes_and_going_to_sleep_does_not() {
        let locked = AtomicBool::new(false);
        let sleep = |b: bool| signal(MANAGER, MANAGER_IFACE, "PrepareForSleep", &(b,));
        assert!(matches!(
            on_signal(&locked, &sleep(false)),
            Some(Msg::Resumed)
        ));
        assert!(on_signal(&locked, &sleep(true)).is_none());
    }

    #[test]
    fn lock_and_unlock_signals_become_messages_once() {
        let locked = AtomicBool::new(false);
        let lock = signal(SESSION, SESSION_IFACE, "Lock", &());
        let unlock = signal(SESSION, SESSION_IFACE, "Unlock", &());
        assert!(matches!(on_signal(&locked, &lock), Some(Msg::Locked)));
        assert!(on_signal(&locked, &lock).is_none());
        assert!(matches!(on_signal(&locked, &unlock), Some(Msg::Unlocked)));
        assert!(on_signal(&locked, &unlock).is_none());
    }

    #[test]
    fn a_locked_hint_change_locks_unless_the_signal_already_did() {
        let hint = |v: bool| {
            let changed = HashMap::from([("LockedHint", zbus::zvariant::Value::from(v))]);
            signal(
                SESSION,
                PROPERTIES,
                "PropertiesChanged",
                &(SESSION_IFACE, changed, Vec::<String>::new()),
            )
        };
        let locked = AtomicBool::new(false);
        assert!(matches!(on_signal(&locked, &hint(true)), Some(Msg::Locked)));
        assert!(on_signal(&locked, &signal(SESSION, SESSION_IFACE, "Lock", &())).is_none());
        assert!(matches!(
            on_signal(&locked, &hint(false)),
            Some(Msg::Unlocked)
        ));
    }

    #[test]
    fn other_interfaces_properties_are_ignored() {
        let changed = HashMap::from([("LockedHint", zbus::zvariant::Value::from(true))]);
        let msg = signal(
            SESSION,
            PROPERTIES,
            "PropertiesChanged",
            &("org.freedesktop.login1.Seat", changed, Vec::<String>::new()),
        );
        assert!(on_signal(&AtomicBool::new(false), &msg).is_none());
    }
}
