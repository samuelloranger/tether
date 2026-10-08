use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use zbus::Message;
use zbus::blocking::Connection;
use zbus::zvariant::Value;

use super::bus::{SessionBus, for_each_signal, signal_rule};
use crate::terminal::model::Msg;
use tether_core::toast::{body_lines, escape};

const DEST: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

/// The summary and body of a notification: the header, then the first two non-empty body lines.
/// `markup` is whether the daemon renders `<`, `>` and `&` in the body as markup.
pub fn content(header: &str, body: &str, markup: bool) -> (String, String) {
    let lines: Vec<String> = body_lines(body)
        .into_iter()
        .map(|l| if markup { escape(l) } else { l.to_string() })
        .collect();
    (header.to_string(), lines.join("\n"))
}

/// `None` when the daemon could not be asked, which must not be remembered.
pub fn markup_from(caps: Option<Vec<String>>) -> Option<bool> {
    caps.map(|c| c.iter().any(|c| c == "body-markup"))
}

/// The live notification of each session, so a newer one replaces it and a click finds its tab.
#[derive(Default)]
pub struct Live {
    by_session: HashMap<(String, String), u32>,
    by_id: HashMap<u32, (String, String)>,
}

impl Live {
    /// The id to replace, or 0 for a new notification.
    pub fn replaces(&self, machine: &str, session: &str) -> u32 {
        self.by_session
            .get(&(machine.to_string(), session.to_string()))
            .copied()
            .unwrap_or(0)
    }

    pub fn shown(&mut self, id: u32, machine: &str, session: &str) {
        let key = (machine.to_string(), session.to_string());
        if let Some(old) = self.by_session.insert(key.clone(), id)
            && old != id
        {
            self.by_id.remove(&old);
        }
        // A restarted daemon hands out ids again: the session that held this one lost it.
        if let Some(prev) = self.by_id.insert(id, key.clone())
            && prev != key
        {
            self.by_session.remove(&prev);
        }
    }

    pub fn closed(&mut self, id: u32) {
        if let Some(key) = self.by_id.remove(&id)
            && self.by_session.get(&key) == Some(&id)
        {
            self.by_session.remove(&key);
        }
    }

    pub fn clicked(&self, id: u32, action: &str) -> Option<Msg> {
        if action != "default" {
            return None;
        }
        let (machine, name) = self.by_id.get(&id)?.clone();
        Some(Msg::ToastClicked { machine, name })
    }
}

/// The message a notification signal means, updating `live` for a closed one.
pub fn on_signal(live: &Mutex<Live>, msg: &Message) -> Option<Msg> {
    let header = msg.header();
    let body = msg.body();
    match header.member()?.as_str() {
        "ActionInvoked" => {
            let (id, action): (u32, String) = body.deserialize().ok()?;
            live.lock().unwrap().clicked(id, &action)
        }
        "NotificationClosed" => {
            let (id, _reason): (u32, u32) = body.deserialize().ok()?;
            live.lock().unwrap().closed(id);
            None
        }
        _ => None,
    }
}

pub struct Notifier {
    bus: SessionBus,
    live: Arc<Mutex<Live>>,
    markup: Arc<Mutex<Option<bool>>>,
}

impl Notifier {
    pub fn new() -> Self {
        let live = Arc::new(Mutex::new(Live::default()));
        let listener = live.clone();
        // The listener subscribes as soon as the connection exists, before the first notification is sent.
        let bus = SessionBus::spawn(move |conn| {
            let conn = conn.clone();
            let spawned = std::thread::Builder::new()
                .name("notification-signals".into())
                .spawn(move || {
                    let rules = ["ActionInvoked", "NotificationClosed"]
                        .map(|m| signal_rule(DEST, m, Some(PATH)))
                        .into_iter()
                        .collect::<Result<Vec<_>, _>>();
                    let Ok(rules) = rules else { return };
                    let result = for_each_signal(&conn, rules, |msg| {
                        if let Some(m) = on_signal(&listener, msg) {
                            super::deliver(m);
                        }
                    });
                    if let Err(e) = result {
                        tracing::debug!("notification signals stopped: {e}");
                    }
                });
            if let Err(e) = spawned {
                tracing::debug!("notification listener failed: {e}");
            }
        });
        Self {
            bus,
            live,
            markup: Arc::new(Mutex::new(None)),
        }
    }

    pub fn bus(&self) -> &SessionBus {
        &self.bus
    }

    pub fn show(&self, machine: &str, session: &str, title: &str, body: &str) {
        let (live, markup) = (self.live.clone(), self.markup.clone());
        let (machine, session) = (machine.to_string(), session.to_string());
        let (title, body) = (title.to_string(), body.to_string());
        self.bus.run(move |conn| {
            let known = *markup.lock().unwrap();
            let markup = known.unwrap_or_else(|| {
                let asked = supports_markup(conn);
                *markup.lock().unwrap() = asked;
                // Unasked, escape: unescaped text on a markup daemon could render as links.
                asked.unwrap_or(true)
            });
            let (summary, text) = content(&title, &body, markup);
            let replaces = live.lock().unwrap().replaces(&machine, &session);
            match notify(conn, replaces, &summary, &text) {
                Ok(id) => live.lock().unwrap().shown(id, &machine, &session),
                Err(e) => tracing::debug!("notification failed: {e}"),
            }
        });
    }
}

fn supports_markup(conn: &Connection) -> Option<bool> {
    let caps = conn
        .call_method(Some(DEST), PATH, Some(DEST), "GetCapabilities", &())
        .ok()
        .and_then(|r| r.body().deserialize::<Vec<String>>().ok());
    markup_from(caps)
}

fn notify(conn: &Connection, replaces: u32, summary: &str, body: &str) -> zbus::Result<u32> {
    let hints: HashMap<&str, Value> = HashMap::from([
        ("desktop-entry", Value::from("tether")),
        ("suppress-sound", Value::from(true)),
    ]);
    let reply = conn.call_method(
        Some(DEST),
        PATH,
        Some(DEST),
        "Notify",
        &(
            "Tether",
            replaces,
            "tether",
            summary,
            body,
            vec!["default", "Open"],
            hints,
            -1i32,
        ),
    )?;
    reply.body().deserialize()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal<B>(member: &str, body: &B) -> Message
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        Message::signal(PATH, DEST, member)
            .unwrap()
            .build(body)
            .unwrap()
    }

    #[test]
    fn the_body_is_its_first_two_non_empty_lines() {
        let (s, b) = content("devbox · b", "Claude\n\nNeeds you\nthird", false);
        assert_eq!(
            (s.as_str(), b.as_str()),
            ("devbox · b", "Claude\nNeeds you")
        );
        assert_eq!(content("h", "", false).1, "");
    }

    #[test]
    fn markup_is_escaped_only_for_a_daemon_that_renders_it() {
        assert_eq!(content("h", "a <b> & c", true).1, "a &lt;b&gt; &amp; c");
        assert_eq!(content("h", "a <b> & c", false).1, "a <b> & c");
    }

    #[test]
    fn a_newer_notification_replaces_the_live_one_of_its_session() {
        let mut live = Live::default();
        assert_eq!(live.replaces("m", "s"), 0);
        live.shown(7, "m", "s");
        assert_eq!(live.replaces("m", "s"), 7);
        assert_eq!(live.replaces("m", "other"), 0);
        assert_eq!(live.replaces("m2", "s"), 0);
        live.shown(9, "m", "s");
        assert!(live.clicked(7, "default").is_none());
        assert!(live.clicked(9, "default").is_some());
        live.closed(9);
        assert_eq!(live.replaces("m", "s"), 0);
    }

    #[test]
    fn the_default_action_is_a_click_on_its_tab() {
        let live = Mutex::new(Live::default());
        live.lock().unwrap().shown(4, "m1", "build");
        let click = on_signal(&live, &signal("ActionInvoked", &(4u32, "default")));
        assert!(matches!(
            click,
            Some(Msg::ToastClicked { machine, name }) if machine == "m1" && name == "build"
        ));
        assert!(on_signal(&live, &signal("ActionInvoked", &(4u32, "other"))).is_none());
        assert!(on_signal(&live, &signal("ActionInvoked", &(5u32, "default"))).is_none());
    }

    #[test]
    fn a_closed_notification_forgets_its_session() {
        let live = Mutex::new(Live::default());
        live.lock().unwrap().shown(4, "m", "s");
        assert!(on_signal(&live, &signal("NotificationClosed", &(4u32, 2u32))).is_none());
        assert_eq!(live.lock().unwrap().replaces("m", "s"), 0);
    }
}
