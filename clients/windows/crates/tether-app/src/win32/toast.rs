pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn toast_xml(header: &str, body: &str, session: &str) -> String {
    let lines: String = body
        .lines()
        .filter(|l| !l.is_empty())
        .take(2)
        .map(|l| format!("<text>{}</text>", escape(l)))
        .collect();
    format!(
        "<toast launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text>{}</binding></visual><audio silent=\"true\"/></toast>",
        escape(&format!("tether:tab={session}")),
        escape(header),
        lines
    )
}

pub fn toast_tag(session: &str) -> String {
    if session.encode_utf16().count() <= 64 && session.is_ascii() {
        return session.to_string();
    }
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    session.hash(&mut h);
    format!("s{:016x}", h.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_escapes_program_text() {
        let xml = toast_xml("devbox · b", "a <b> & \"c\"", "b");
        assert!(xml.contains("<text>devbox · b</text>"));
        assert!(xml.contains("<text>a &lt;b&gt; &amp; &quot;c&quot;</text>"));
        assert!(xml.contains("launch=\"tether:tab=b\""));
        assert!(xml.contains("<audio silent=\"true\"/>"));
    }

    #[test]
    fn a_two_line_body_becomes_two_texts() {
        let xml = toast_xml("h", "Claude\nNeeds you", "s");
        assert!(xml.contains("<text>Claude</text><text>Needs you</text>"));
    }

    #[test]
    fn long_or_unicode_names_hash_into_a_short_tag() {
        assert_eq!(toast_tag("build"), "build");
        assert!(toast_tag(&"x".repeat(80)).len() <= 64);
        assert!(toast_tag("日本").starts_with('s'));
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::win32::aumid::{AUMID, ToastIdentity};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier};
    use windows::core::HSTRING;

    pub struct Toaster {
        notifier: ToastNotifier,
        live: Mutex<HashMap<String, ToastNotification>>,
    }

    impl Toaster {
        pub fn new(identity: ToastIdentity) -> Option<Self> {
            let notifier = match identity {
                ToastIdentity::Packaged => ToastNotificationManager::CreateToastNotifier(),
                ToastIdentity::Portable => {
                    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
                }
            }
            .ok()?;
            Some(Self {
                notifier,
                live: Mutex::new(HashMap::new()),
            })
        }

        pub fn show(&self, session: &str, header: &str, body: &str) {
            let shown = (|| -> windows::core::Result<()> {
                let doc = XmlDocument::new()?;
                doc.LoadXml(&HSTRING::from(toast_xml(header, body, session)))?;
                let toast = ToastNotification::CreateToastNotification(&doc)?;
                toast.SetTag(&HSTRING::from(toast_tag(session)))?;
                toast.SetGroup(&HSTRING::from("tether"))?;
                let name = session.to_string();
                toast.Activated(&TypedEventHandler::new(move |_, _| {
                    let name = name.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(s) = crate::terminal::glue::current() {
                            s(crate::terminal::model::Msg::ToastClicked(name));
                        }
                    });
                    Ok(())
                }))?;
                self.notifier.Show(&toast)?;
                self.live.lock().unwrap().insert(session.to_string(), toast);
                Ok(())
            })();
            if let Err(e) = shown {
                tracing::debug!("toast failed: {e}");
            }
        }
    }
}
#[cfg(windows)]
pub use win::Toaster;
