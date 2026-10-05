use uuid::Uuid;

use crate::keys::{KeyError, derive_public_line, is_encrypted, public_key_body};
use crate::profiles::{Auth, Machine};

pub const PASSWORD_PLACEHOLDER_EDIT: &str = "Leave empty to keep the saved password";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthChoice {
    Key(Option<Uuid>),
    Agent,
    Password,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerForm {
    pub name: String,
    pub host: String,
    pub port: String,
    pub user: String,
    pub auth: AuthChoice,
    pub password: String,
    /// Edit of a machine whose password is already stored: an empty field keeps it.
    pub has_saved_password: bool,
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

impl ServerForm {
    pub fn new_add() -> Self {
        Self {
            name: String::new(),
            host: String::new(),
            port: "22".into(),
            user: String::new(),
            auth: AuthChoice::Key(None),
            password: String::new(),
            has_saved_password: false,
        }
    }

    pub fn from_machine(m: &Machine, has_saved_password: bool) -> Self {
        Self {
            name: m.name.clone(),
            host: m.host.clone(),
            port: m.port.to_string(),
            user: m.user.clone(),
            auth: match m.auth {
                Auth::Password => AuthChoice::Password,
                Auth::Agent => AuthChoice::Agent,
                Auth::Key { id } => AuthChoice::Key(Some(id)),
            },
            password: String::new(),
            has_saved_password,
        }
    }

    pub fn hint(&self) -> Option<&'static str> {
        if blank(&self.name) {
            return Some("Name this machine to save it");
        }
        if blank(&self.host) {
            return Some("Add a host to save it");
        }
        if blank(&self.user) {
            return Some("Add a user to save it");
        }
        match self.auth {
            AuthChoice::Password if !self.has_saved_password && blank(&self.password) => {
                Some("Enter a password to save it")
            }
            AuthChoice::Key(None) => Some("Choose a key to save it"),
            _ => None,
        }
    }

    pub fn port_value(&self) -> u16 {
        match self.port.trim().parse::<u32>() {
            Ok(p @ 1..=65535) => p as u16,
            _ => 22,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyForm {
    pub name: String,
    pub private: String,
    pub public: String,
}

impl KeyForm {
    pub fn hint(&self) -> Option<&'static str> {
        if blank(&self.name) {
            return Some("Name this key to save it");
        }
        if !self.private.contains("PRIVATE KEY") {
            return Some("Paste the private key to save it");
        }
        let public = self.public.trim();
        if !(public.starts_with("ssh-") || public.starts_with("ecdsa-")) {
            return Some("Paste the public key to save it");
        }
        if is_encrypted(&self.private) {
            return Some("This key needs a passphrase — Tether can't use it yet");
        }
        match derive_public_line(&self.private) {
            Err(KeyError::Encrypted) => Some("This key needs a passphrase — Tether can't use it yet"),
            // The spec has no sentence for an unreadable key; it is not yet a private key Tether can use.
            Err(_) => Some("Paste the private key to save it"),
            Ok(derived) if public_key_body(public).as_deref() != Some(derived.as_str()) => {
                Some("The public key doesn't match the private key")
            }
            Ok(_) => None,
        }
    }
}

pub fn generate_hint(name: &str) -> Option<&'static str> {
    blank(name).then_some("Name this key to save it")
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED_PRIV: &str = include_str!("../fixtures/keys/ed25519_openssh");
    const ED_PUB: &str = include_str!("../fixtures/keys/ed25519_openssh.pub");
    const ED_ENC: &str = include_str!("../fixtures/keys/ed25519_encrypted");
    const RSA_PUB: &str = include_str!("../fixtures/keys/rsa_pkcs1.pub");

    fn ready() -> ServerForm {
        ServerForm {
            name: "devbox".into(),
            host: "10.0.0.5".into(),
            port: "22".into(),
            user: "sam".into(),
            auth: AuthChoice::Key(Some(Uuid::from_u128(1))),
            password: String::new(),
            has_saved_password: false,
        }
    }

    #[test]
    fn server_hints_in_field_order() {
        let empty = ServerForm::new_add();
        assert_eq!(empty.hint(), Some("Name this machine to save it"));
        let f = ServerForm { name: "  ".into(), host: "".into(), ..ready() };
        assert_eq!(f.hint(), Some("Name this machine to save it"));
        assert_eq!(ServerForm { host: " \t".into(), user: "".into(), ..ready() }.hint(), Some("Add a host to save it"));
        assert_eq!(ServerForm { user: " ".into(), ..ready() }.hint(), Some("Add a user to save it"));
        assert_eq!(ServerForm { auth: AuthChoice::Key(None), ..ready() }.hint(), Some("Choose a key to save it"));
        assert_eq!(ready().hint(), None);
        assert_eq!(ServerForm { auth: AuthChoice::Agent, ..ready() }.hint(), None);
    }

    #[test]
    fn password_hint_only_when_nothing_is_saved() {
        let add = ServerForm { auth: AuthChoice::Password, ..ready() };
        assert_eq!(add.hint(), Some("Enter a password to save it"));
        assert_eq!(ServerForm { password: "   ".into(), ..add.clone() }.hint(), Some("Enter a password to save it"));
        assert_eq!(ServerForm { password: "pw".into(), ..add.clone() }.hint(), None);
        assert_eq!(ServerForm { has_saved_password: true, ..add }.hint(), None);
    }

    #[test]
    fn port_falls_back_to_22() {
        let port = |p: &str| ServerForm { port: p.into(), ..ready() }.port_value();
        assert_eq!(port("2222"), 2222);
        assert_eq!(port(" 2222 "), 2222);
        assert_eq!(port("1"), 1);
        assert_eq!(port("65535"), 65535);
        for bad in ["", "0", "65536", "-1", "22.5", "abc", "99999999999"] {
            assert_eq!(port(bad), 22, "{bad:?}");
        }
    }

    #[test]
    fn edit_form_starts_from_the_machine_with_an_empty_password() {
        let m = Machine { id: Uuid::nil(), name: "devbox".into(), host: "h".into(), port: 2200, user: "u".into(), auth: Auth::Password };
        let f = ServerForm::from_machine(&m, true);
        assert_eq!((f.name.as_str(), f.host.as_str(), f.port.as_str(), f.user.as_str()), ("devbox", "h", "2200", "u"));
        assert_eq!(f.auth, AuthChoice::Password);
        assert!(f.password.is_empty() && f.has_saved_password);
        assert_eq!(f.hint(), None);
    }

    fn key_form(name: &str, private: &str, public: &str) -> KeyForm {
        KeyForm { name: name.into(), private: private.into(), public: public.into() }
    }

    #[test]
    fn key_hints_in_order() {
        assert_eq!(key_form(" ", ED_PRIV, ED_PUB).hint(), Some("Name this key to save it"));
        assert_eq!(key_form("k", "ssh-ed25519 AAAA", ED_PUB).hint(), Some("Paste the private key to save it"));
        assert_eq!(key_form("k", ED_PRIV, "").hint(), Some("Paste the public key to save it"));
        assert_eq!(key_form("k", ED_PRIV, "rsa AAAA").hint(), Some("Paste the public key to save it"));
        assert_eq!(
            key_form("k", ED_ENC, include_str!("../fixtures/keys/ed25519_openssh.pub")).hint(),
            Some("This key needs a passphrase — Tether can't use it yet")
        );
        assert_eq!(key_form("k", ED_PRIV, RSA_PUB).hint(), Some("The public key doesn't match the private key"));
        assert_eq!(key_form("k", ED_PRIV, ED_PUB).hint(), None);
    }

    #[test]
    fn public_key_comment_does_not_affect_match() {
        let bare = public_key_body(ED_PUB).unwrap();
        for public in [bare.clone(), format!("{bare}\n"), format!("  {bare} someone@else\r\n")] {
            assert_eq!(key_form("k", ED_PRIV, &public).hint(), None, "{public:?}");
        }
    }

    #[test]
    fn ecdsa_public_prefix_is_accepted() {
        let ec_priv = include_str!("../fixtures/keys/ecdsa_pkcs8");
        let ec_pub = include_str!("../fixtures/keys/ecdsa_pkcs8.pub");
        assert_eq!(key_form("k", ec_priv, ec_pub).hint(), None);
    }

    #[test]
    fn unreadable_private_key_asks_for_the_private_key() {
        let junk = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
        assert_eq!(key_form("k", junk, ED_PUB).hint(), Some("Paste the private key to save it"));
    }

    #[test]
    fn generate_needs_a_name() {
        assert_eq!(generate_hint("  "), Some("Name this key to save it"));
        assert_eq!(generate_hint("laptop"), None);
    }
}
