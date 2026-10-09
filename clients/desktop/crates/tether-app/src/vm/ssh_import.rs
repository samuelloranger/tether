use std::path::PathBuf;

use tether_core::sshimport::{ImportRow, with_jumps};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRowView {
    pub label: String,
    pub detail: String,
    pub auth: String,
    pub via: String,
    pub existing: bool,
    pub checked: bool,
}

pub struct SshImportVm {
    pub rows: Vec<ImportRow>,
    checked: Vec<bool>,
    pub error: Option<String>,
}

/// `%USERPROFILE%` on Windows; `$HOME` elsewhere, for tests and dev runs.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub fn default_user() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
}

impl SshImportVm {
    /// Saved endpoints start unchecked and can't be checked: they're already on Home.
    pub fn new(rows: Vec<ImportRow>) -> Self {
        let checked = rows.iter().map(|r| !r.existing).collect();
        Self {
            rows,
            checked,
            error: None,
        }
    }

    pub fn toggle(&mut self, i: usize) {
        if let (Some(c), Some(r)) = (self.checked.get_mut(i), self.rows.get(i))
            && !r.existing
        {
            *c = !*c;
        }
        self.error = None;
    }

    /// The checked rows and the unsaved jumps they need.
    pub fn picked(&self) -> Vec<usize> {
        let chosen: Vec<usize> = (0..self.rows.len()).filter(|&i| self.checked[i]).collect();
        with_jumps(&self.rows, &chosen)
    }

    pub fn views(&self) -> Vec<ImportRowView> {
        let picked = self.picked();
        self.rows
            .iter()
            .enumerate()
            .map(|(i, r)| ImportRowView {
                label: r.label.clone(),
                detail: format!("{}@{}:{}", r.machine.user, r.machine.host, r.machine.port),
                auth: r.auth_note.clone(),
                via: r
                    .via
                    .clone()
                    .map(|v| format!("via {v}"))
                    .unwrap_or_default(),
                existing: r.existing,
                checked: picked.contains(&i),
            })
            .collect()
    }

    pub fn import_label(&self) -> String {
        match self.picked().len() {
            0 => "Import".into(),
            1 => "Import 1 machine".into(),
            n => format!("Import {n} machines"),
        }
    }

    pub fn can_import(&self) -> bool {
        !self.picked().is_empty()
    }

    pub fn hint(&self) -> String {
        if let Some(e) = &self.error {
            return e.clone();
        }
        if self.rows.is_empty() {
            return "No hosts found in ~/.ssh/config.".into();
        }
        if self.rows.iter().all(|r| r.existing) {
            return "Every host here is already on Home.".into();
        }
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::sshconfig::ConfigHost;
    use tether_core::sshimport::plan;
    use tether_core::{Auth, KeyRecords, Machine};
    use uuid::Uuid;

    fn host(alias: &str, jumps: &[&str]) -> ConfigHost {
        ConfigHost {
            alias: alias.into(),
            host: format!("{alias}.lan"),
            port: 22,
            user: Some("u".into()),
            identity_file: None,
            jumps: jumps.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn vm(saved: &[Machine]) -> SshImportVm {
        let rows = plan(
            &[host("bastion", &[]), host("inner", &["bastion"])],
            saved,
            &KeyRecords::default(),
            "w",
            &[],
            &|_| None,
        );
        SshImportVm::new(rows)
    }

    #[test]
    fn new_hosts_start_checked_and_the_label_counts_them() {
        let v = vm(&[]);
        assert_eq!(v.import_label(), "Import 2 machines");
        let views = v.views();
        assert_eq!(views[1].detail, "u@inner.lan:22");
        assert_eq!(views[1].via, "via bastion");
        assert!(views.iter().all(|r| r.checked));
    }

    #[test]
    fn a_jump_stays_checked_while_a_host_needs_it() {
        let mut v = vm(&[]);
        v.toggle(0);
        assert!(v.views()[0].checked, "inner still goes through bastion");
        v.toggle(1);
        assert!(!v.can_import());
        assert_eq!(v.import_label(), "Import");
    }

    #[test]
    fn saved_hosts_cannot_be_checked() {
        let saved = Machine {
            id: Uuid::from_u128(1),
            name: "b".into(),
            host: "bastion.lan".into(),
            port: 22,
            user: "u".into(),
            auth: Auth::Agent,
            jump: None,
        };
        let mut v = vm(std::slice::from_ref(&saved));
        v.toggle(0);
        let views = v.views();
        assert!(views[0].existing && !views[0].checked);
        assert_eq!(v.import_label(), "Import 1 machine");
    }

    #[test]
    fn empty_and_all_saved_explain_themselves() {
        assert_eq!(
            SshImportVm::new(Vec::new()).hint(),
            "No hosts found in ~/.ssh/config."
        );
    }
}
