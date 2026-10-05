use tether_core::{AuthChoice, KeyRecords, Machine, ServerForm, hints::PASSWORD_PLACEHOLDER_EDIT};
use uuid::Uuid;

pub struct ServerInput {
    pub name: String,
    pub host: String,
    pub port: String,
    pub user: String,
    pub segment: i32,
    pub key_index: i32,
    pub password: String,
}

pub struct ServerFormVm {
    pub editing: Option<Uuid>,
    pub form: ServerForm,
    pub error: Option<String>,
}

impl ServerFormVm {
    pub fn add() -> Self {
        Self {
            editing: None,
            form: ServerForm::new_add(),
            error: None,
        }
    }

    pub fn edit(m: &Machine, has_saved_password: bool, keys: &KeyRecords) -> Self {
        let mut form = ServerForm::from_machine(m, has_saved_password);
        if let AuthChoice::Key(Some(id)) = form.auth {
            if keys.get(id).is_none() {
                form.auth = AuthChoice::Key(None);
            }
        }
        Self {
            editing: Some(m.id),
            form,
            error: None,
        }
    }

    pub fn title(&self) -> &'static str {
        if self.editing.is_some() {
            "Edit server"
        } else {
            "Add a server"
        }
    }

    pub fn save_label(&self) -> &'static str {
        if self.editing.is_some() {
            "Save changes"
        } else {
            "Save server"
        }
    }

    pub fn password_placeholder(&self) -> &'static str {
        if self.editing.is_some() && self.form.has_saved_password {
            PASSWORD_PLACEHOLDER_EDIT
        } else {
            ""
        }
    }

    pub fn segment(&self) -> i32 {
        match self.form.auth {
            AuthChoice::Key(_) => 0,
            AuthChoice::Agent => 1,
            AuthChoice::Password => 2,
        }
    }

    pub fn key_index(&self, keys: &KeyRecords) -> i32 {
        match self.form.auth {
            AuthChoice::Key(Some(id)) => keys
                .keys
                .iter()
                .position(|k| k.id == id)
                .map_or(-1, |i| i as i32),
            _ => -1,
        }
    }

    pub fn key_names(keys: &KeyRecords) -> Vec<String> {
        keys.keys.iter().map(|k| k.name.clone()).collect()
    }

    pub fn apply(&mut self, input: ServerInput, keys: &KeyRecords) {
        self.form.name = input.name;
        self.form.host = input.host;
        self.form.port = input.port;
        self.form.user = input.user;
        self.form.password = input.password;
        self.form.auth = match input.segment {
            1 => AuthChoice::Agent,
            2 => AuthChoice::Password,
            _ => AuthChoice::Key(
                usize::try_from(input.key_index)
                    .ok()
                    .and_then(|i| keys.keys.get(i))
                    .map(|k| k.id),
            ),
        };
        self.error = None;
    }

    pub fn hint(&self) -> String {
        self.error
            .clone()
            .or_else(|| self.form.hint().map(str::to_owned))
            .unwrap_or_default()
    }

    pub fn can_save(&self) -> bool {
        self.form.hint().is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::{Auth, KeyOrigin, KeyRecord};

    fn keys() -> KeyRecords {
        let k = |id: u128, name: &str| KeyRecord {
            id: Uuid::from_u128(id),
            name: name.into(),
            algorithm: "ssh-ed25519".into(),
            public_line: "ssh-ed25519 AAAA x".into(),
            fingerprint: "SHA256:x".into(),
            origin: KeyOrigin::Generated,
            created: 0,
        };
        KeyRecords {
            keys: vec![k(9, "id_ed25519"), k(10, "work")],
        }
    }

    fn input(segment: i32, key_index: i32, password: &str) -> ServerInput {
        ServerInput {
            name: "devbox".into(),
            host: "192.0.2.10".into(),
            port: "22".into(),
            user: "dev".into(),
            segment,
            key_index,
            password: password.into(),
        }
    }

    #[test]
    fn add_starts_empty_and_asks_for_a_name() {
        let vm = ServerFormVm::add();
        assert_eq!(vm.title(), "Add a server");
        assert_eq!(vm.save_label(), "Save server");
        assert_eq!(vm.form.port, "22");
        assert_eq!(vm.segment(), 0);
        assert_eq!(vm.key_index(&keys()), -1);
        assert_eq!(vm.hint(), "Name this machine to save it");
        assert!(!vm.can_save());
        assert_eq!(vm.password_placeholder(), "");
    }

    #[test]
    fn choosing_a_key_completes_the_form() {
        let mut vm = ServerFormVm::add();
        vm.apply(input(0, -1, ""), &keys());
        assert_eq!(vm.hint(), "Choose a key to save it");
        vm.apply(input(0, 1, ""), &keys());
        assert_eq!(vm.form.auth, AuthChoice::Key(Some(Uuid::from_u128(10))));
        assert!(vm.can_save());
        assert_eq!(vm.hint(), "");
    }

    #[test]
    fn segments_map_to_agent_and_password() {
        let mut vm = ServerFormVm::add();
        vm.apply(input(1, -1, ""), &keys());
        assert_eq!(vm.form.auth, AuthChoice::Agent);
        assert!(vm.can_save());
        vm.apply(input(2, -1, ""), &keys());
        assert_eq!(vm.hint(), "Enter a password to save it");
        vm.apply(input(2, -1, "hunter2"), &keys());
        assert!(vm.can_save());
    }

    #[test]
    fn edit_has_its_own_labels_and_keeps_a_saved_password() {
        let m = Machine {
            id: Uuid::from_u128(1),
            name: "vps".into(),
            host: "h".into(),
            port: 2222,
            user: "root".into(),
            auth: Auth::Password,
        };
        let vm = ServerFormVm::edit(&m, true, &keys());
        assert_eq!(vm.title(), "Edit server");
        assert_eq!(vm.save_label(), "Save changes");
        assert_eq!(vm.form.port, "2222");
        assert_eq!(vm.segment(), 2);
        assert_eq!(
            vm.password_placeholder(),
            "Leave empty to keep the saved password"
        );
        assert!(vm.can_save());
    }

    #[test]
    fn missing_key_is_not_preselected() {
        let m = Machine {
            id: Uuid::from_u128(1),
            name: "old".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            auth: Auth::Key {
                id: Uuid::from_u128(77),
            },
        };
        let vm = ServerFormVm::edit(&m, false, &keys());
        assert_eq!(vm.form.auth, AuthChoice::Key(None));
        assert_eq!(vm.key_index(&keys()), -1);
        assert_eq!(vm.hint(), "Choose a key to save it");
    }

    #[test]
    fn a_save_error_shows_until_the_next_edit() {
        let mut vm = ServerFormVm::add();
        vm.apply(input(1, -1, ""), &keys());
        vm.error = Some("Couldn't save: Access is denied.".into());
        assert_eq!(vm.hint(), "Couldn't save: Access is denied.");
        vm.apply(input(1, -1, ""), &keys());
        assert_eq!(vm.hint(), "");
    }

    #[test]
    fn key_names_are_in_vault_order() {
        assert_eq!(
            ServerFormVm::key_names(&keys()),
            vec!["id_ed25519", "work"]
        );
    }
}
