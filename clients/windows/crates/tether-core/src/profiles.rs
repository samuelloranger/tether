use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::keys::KeyRecords;

pub const PROFILES_FILE: &str = "profiles.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Auth {
    Password,
    Agent,
    Key { id: Uuid },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
}

impl Machine {
    pub fn auth_label(&self, keys: &KeyRecords) -> String {
        match &self.auth {
            Auth::Password => "password".into(),
            Auth::Agent => "agent".into(),
            Auth::Key { id } => keys.get(*id).map_or_else(|| "key missing".into(), |k| k.name.clone()),
        }
    }

    pub fn summary(&self, keys: &KeyRecords) -> String {
        format!("{}@{}:{} · {}", self.user, self.host, self.port, self.auth_label(keys))
    }

    pub fn key_missing(&self, keys: &KeyRecords) -> bool {
        matches!(&self.auth, Auth::Key { id } if keys.get(*id).is_none())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profiles {
    pub machines: Vec<Machine>,
}

impl Profiles {
    pub fn get(&self, id: Uuid) -> Option<&Machine> {
        self.machines.iter().find(|m| m.id == id)
    }

    pub fn add(&mut self, machine: Machine) {
        self.machines.push(machine);
    }

    pub fn replace(&mut self, machine: Machine) -> bool {
        match self.machines.iter_mut().find(|m| m.id == machine.id) {
            Some(slot) => {
                *slot = machine;
                true
            }
            None => false,
        }
    }

    pub fn remove(&mut self, id: Uuid) -> Option<Machine> {
        let at = self.machines.iter().position(|m| m.id == id)?;
        Some(self.machines.remove(at))
    }

    pub fn using_key(&self, key: Uuid) -> Vec<&Machine> {
        self.machines.iter().filter(|m| m.auth == Auth::Key { id: key }).collect()
    }
}

pub fn machines_subtitle(count: usize) -> String {
    match count {
        0 => "no machines yet".into(),
        1 => "1 machine".into(),
        n => format!("{n} machines"),
    }
}

pub fn keys_subtitle(count: usize) -> String {
    let noun = if count == 1 { "key" } else { "keys" };
    format!("{count} {noun} · on this PC")
}

pub fn used_by_line(machines: &[&Machine]) -> String {
    if machines.is_empty() {
        return "not used yet".into();
    }
    let names: Vec<&str> = machines.iter().map(|m| m.name.as_str()).collect();
    format!("used by {}", names.join(", "))
}

pub fn delete_key_warning(machines: &[&Machine]) -> Option<String> {
    let names: Vec<&str> = machines.iter().map(|m| m.name.as_str()).collect();
    match names.as_slice() {
        [] => None,
        [one] => Some(format!("{one} won't be able to sign in until it gets another key.")),
        [rest @ .., last] => Some(format!(
            "{} and {last} won't be able to sign in until they get another key.",
            rest.join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{KeyOrigin, KeyRecord, KeyRecords};

    fn key(id: u128, name: &str) -> KeyRecord {
        KeyRecord {
            id: Uuid::from_u128(id),
            name: name.into(),
            algorithm: "ssh-ed25519".into(),
            public_line: "ssh-ed25519 AAAA".into(),
            fingerprint: "SHA256:x".into(),
            origin: KeyOrigin::Generated,
            created: 0,
        }
    }

    fn machine(id: u128, name: &str, auth: Auth) -> Machine {
        Machine { id: Uuid::from_u128(id), name: name.into(), host: "10.0.0.5".into(), port: 22, user: "sam".into(), auth }
    }

    #[test]
    fn auth_serializes_with_a_kind_tag() {
        let json = serde_json::to_string(&Auth::Key { id: Uuid::nil() }).unwrap();
        assert_eq!(json, r#"{"kind":"key","id":"00000000-0000-0000-0000-000000000000"}"#);
        assert_eq!(serde_json::to_string(&Auth::Agent).unwrap(), r#"{"kind":"agent"}"#);
        assert_eq!(serde_json::to_string(&Auth::Password).unwrap(), r#"{"kind":"password"}"#);
    }

    #[test]
    fn profiles_never_serialize_a_secret_field() {
        let p = Profiles { machines: vec![machine(1, "devbox", Auth::Password)] };
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("secret") && !json.contains("pem"));
        let back: Profiles = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn summary_names_the_key_agent_password_or_missing_key() {
        let keys = KeyRecords { keys: vec![key(9, "id_ed25519")] };
        let m = machine(1, "devbox", Auth::Key { id: Uuid::from_u128(9) });
        assert_eq!(m.summary(&keys), "sam@10.0.0.5:22 · id_ed25519");
        assert_eq!(machine(1, "d", Auth::Agent).summary(&keys), "sam@10.0.0.5:22 · agent");
        assert_eq!(machine(1, "d", Auth::Password).summary(&keys), "sam@10.0.0.5:22 · password");
        let orphan = machine(1, "d", Auth::Key { id: Uuid::from_u128(8) });
        assert_eq!(orphan.summary(&keys), "sam@10.0.0.5:22 · key missing");
        assert!(orphan.key_missing(&keys));
        assert!(!m.key_missing(&keys));
    }

    #[test]
    fn add_replace_remove_keep_insertion_order() {
        let mut p = Profiles::default();
        p.add(machine(1, "a", Auth::Agent));
        p.add(machine(2, "b", Auth::Agent));
        assert!(p.replace(machine(1, "a2", Auth::Agent)));
        assert_eq!(p.machines.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["a2", "b"]);
        assert_eq!(p.remove(Uuid::from_u128(1)).unwrap().name, "a2");
        assert!(p.remove(Uuid::from_u128(1)).is_none());
        assert!(!p.replace(machine(7, "x", Auth::Agent)));
    }

    #[test]
    fn subtitles() {
        assert_eq!(machines_subtitle(0), "no machines yet");
        assert_eq!(machines_subtitle(1), "1 machine");
        assert_eq!(machines_subtitle(2), "2 machines");
        assert_eq!(keys_subtitle(1), "1 key · on this PC");
        assert_eq!(keys_subtitle(2), "2 keys · on this PC");
    }

    #[test]
    fn key_usage_lines() {
        let k = Uuid::from_u128(9);
        let mut p = Profiles::default();
        assert_eq!(used_by_line(&p.using_key(k)), "not used yet");
        assert_eq!(delete_key_warning(&p.using_key(k)), None);
        p.add(machine(1, "devbox", Auth::Key { id: k }));
        assert_eq!(used_by_line(&p.using_key(k)), "used by devbox");
        assert_eq!(
            delete_key_warning(&p.using_key(k)).unwrap(),
            "devbox won't be able to sign in until it gets another key."
        );
        p.add(machine(2, "nas", Auth::Key { id: k }));
        p.add(machine(3, "pi", Auth::Key { id: k }));
        assert_eq!(used_by_line(&p.using_key(k)), "used by devbox, nas, pi");
        assert_eq!(
            delete_key_warning(&p.using_key(k)).unwrap(),
            "devbox, nas and pi won't be able to sign in until they get another key."
        );
    }
}
