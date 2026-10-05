use uuid::Uuid;
use zeroize::Zeroizing;

use crate::hints::{AuthChoice, ServerForm};
use crate::profiles::{Auth, Machine};

pub enum PasswordAction {
    Keep,
    Set(Zeroizing<String>),
    Delete,
}

pub fn apply_server_form(
    existing: Option<&Machine>,
    form: &ServerForm,
) -> (Machine, PasswordAction) {
    debug_assert!(form.hint().is_none(), "save is disabled while a hint shows");
    let auth = match form.auth {
        AuthChoice::Password => Auth::Password,
        AuthChoice::Agent => Auth::Agent,
        AuthChoice::Key(Some(id)) => Auth::Key { id },
        // Unreachable behind the hint; never invent a key, keep what was there.
        AuthChoice::Key(None) => existing.map_or(Auth::Agent, |m| m.auth.clone()),
    };
    let had_password = existing.is_some_and(|m| m.auth == Auth::Password);
    let action = match auth {
        Auth::Password if !form.password.trim().is_empty() => {
            PasswordAction::Set(Zeroizing::new(form.password.clone()))
        }
        Auth::Password => PasswordAction::Keep,
        _ if had_password => PasswordAction::Delete,
        _ => PasswordAction::Keep,
    };
    let machine = Machine {
        id: existing.map_or_else(Uuid::new_v4, |m| m.id),
        name: form.name.clone(),
        host: form.host.trim().to_string(),
        port: form.port_value(),
        user: form.user.trim().to_string(),
        auth,
    };
    (machine, action)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing(auth: Auth) -> Machine {
        Machine {
            id: Uuid::from_u128(5),
            name: "devbox".into(),
            host: "old".into(),
            port: 22,
            user: "sam".into(),
            auth,
        }
    }

    fn form(auth: AuthChoice, password: &str, saved: bool) -> ServerForm {
        ServerForm {
            name: "devbox".into(),
            host: "  10.0.0.9 ".into(),
            port: "70000".into(),
            user: " sam\t".into(),
            auth,
            password: password.into(),
            has_saved_password: saved,
        }
    }

    #[test]
    fn add_trims_host_and_user_and_falls_back_to_port_22() {
        let (m, action) = apply_server_form(None, &form(AuthChoice::Agent, "", false));
        assert_eq!(
            (m.host.as_str(), m.user.as_str(), m.port),
            ("10.0.0.9", "sam", 22)
        );
        assert_eq!(m.auth, Auth::Agent);
        assert!(matches!(action, PasswordAction::Keep));
        assert_ne!(m.id, Uuid::nil());
    }

    #[test]
    fn add_with_password_sets_it() {
        let (m, action) = apply_server_form(None, &form(AuthChoice::Password, "pw", false));
        assert_eq!(m.auth, Auth::Password);
        assert!(matches!(action, PasswordAction::Set(p) if p.as_str() == "pw"));
    }

    #[test]
    fn edit_keeps_the_id() {
        let old = existing(Auth::Agent);
        let (m, _) = apply_server_form(Some(&old), &form(AuthChoice::Agent, "", false));
        assert_eq!(m.id, old.id);
    }

    #[test]
    fn edit_with_empty_password_keeps_the_saved_one() {
        let old = existing(Auth::Password);
        let (_, action) = apply_server_form(Some(&old), &form(AuthChoice::Password, "", true));
        assert!(matches!(action, PasswordAction::Keep));
    }

    #[test]
    fn edit_with_new_password_replaces_it() {
        let old = existing(Auth::Password);
        let (_, action) = apply_server_form(Some(&old), &form(AuthChoice::Password, "new", true));
        assert!(matches!(action, PasswordAction::Set(p) if p.as_str() == "new"));
    }

    #[test]
    fn leaving_password_deletes_it() {
        let old = existing(Auth::Password);
        let key = Uuid::from_u128(9);
        let (m, action) =
            apply_server_form(Some(&old), &form(AuthChoice::Key(Some(key)), "", true));
        assert_eq!(m.auth, Auth::Key { id: key });
        assert!(matches!(action, PasswordAction::Delete));
        let (_, action) = apply_server_form(
            Some(&old),
            &form(AuthChoice::Agent, "typed-but-ignored", true),
        );
        assert!(matches!(action, PasswordAction::Delete));
    }

    #[test]
    fn switching_between_key_and_agent_touches_no_password() {
        let old = existing(Auth::Agent);
        let (_, action) = apply_server_form(
            Some(&old),
            &form(AuthChoice::Key(Some(Uuid::from_u128(1))), "", false),
        );
        assert!(matches!(action, PasswordAction::Keep));
    }
}
