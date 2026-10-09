//! Turns `~/.ssh/config` hosts into machines and keys, without touching storage.

use std::path::{Path, PathBuf};

use uuid::Uuid;
use zeroize::Zeroizing;

use crate::keys::{KeyRecords, derive_public_line, fingerprint, is_encrypted, normalize_pem};
use crate::profiles::{Auth, Machine};
use crate::sshconfig::{ConfigHost, parse_hop};

#[derive(Debug, Clone)]
pub struct ImportKey {
    pub id: Uuid,
    pub name: String,
    pub private: Zeroizing<String>,
    pub public_line: String,
}

#[derive(Debug, Clone)]
pub struct ImportRow {
    /// The config alias, or the hop as written when a ProxyJump names a host that has no alias.
    pub label: String,
    pub machine: Machine,
    /// A key this row brings into the vault. `None` when it uses the agent or a vault key.
    pub key: Option<ImportKey>,
    /// A machine with the same user, host and port is already saved.
    pub existing: bool,
    pub auth_note: String,
    pub via: Option<String>,
}

fn same_endpoint(a: &Machine, b: &Machine) -> bool {
    a.user == b.user && a.port == b.port && a.host.eq_ignore_ascii_case(&b.host)
}

/// The keys OpenSSH tries when a host names no `IdentityFile`, in the order Tether picks one.
pub fn default_identity_files(home: &Path) -> Vec<PathBuf> {
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| home.join(".ssh").join(name))
        .collect()
}

/// Every concrete host, plus a row for each ProxyJump hop that is not an alias.
/// `read` reads a key file; `default_user` fills hosts with no `User`; `default_keys`
/// stand in for a missing `IdentityFile`.
pub fn plan(
    hosts: &[ConfigHost],
    machines: &[Machine],
    keys: &KeyRecords,
    default_user: &str,
    default_keys: &[PathBuf],
    read: &dyn Fn(&Path) -> Option<String>,
) -> Vec<ImportRow> {
    let mut rows: Vec<ImportRow> = Vec::new();
    for h in hosts {
        let (auth, key, auth_note) = match h.identity_file.as_deref() {
            Some(path) => key_for(Some(path), keys, read),
            None => default_key(default_keys, keys, read),
        };
        let machine = Machine {
            id: Uuid::new_v4(),
            name: h.alias.clone(),
            host: h.host.clone(),
            port: h.port,
            user: h.user.clone().unwrap_or_else(|| default_user.to_string()),
            auth,
            jump: None,
        };
        rows.push(row(h.alias.clone(), machine, key, auth_note, machines));
    }
    for h in hosts {
        let mut previous: Option<Uuid> = None;
        for hop in &h.jumps {
            let id = match rows.iter().position(|r| r.label == *hop) {
                Some(i) => rows[i].machine.id,
                None => {
                    let (user, host, port) = parse_hop(hop);
                    let (auth, key, auth_note) = default_key(default_keys, keys, read);
                    let machine = Machine {
                        id: Uuid::new_v4(),
                        name: hop.clone(),
                        host,
                        port,
                        user: user.unwrap_or_else(|| default_user.to_string()),
                        auth,
                        jump: previous,
                    };
                    let id = machine.id;
                    rows.push(row(hop.clone(), machine, key, auth_note, machines));
                    id
                }
            };
            previous = Some(id);
        }
        if let Some(i) = rows.iter().position(|r| r.label == h.alias) {
            rows[i].machine.jump = previous;
        }
    }
    let names: Vec<(Uuid, String)> = rows
        .iter()
        .map(|r| (r.machine.id, r.label.clone()))
        .collect();
    for r in &mut rows {
        r.via = r
            .machine
            .jump
            .and_then(|j| names.iter().find(|(id, _)| *id == j))
            .map(|(_, n)| n.clone());
    }
    rows
}

fn row(
    label: String,
    mut machine: Machine,
    key: Option<ImportKey>,
    auth_note: String,
    machines: &[Machine],
) -> ImportRow {
    let existing = machines.iter().find(|m| same_endpoint(m, &machine));
    // An existing machine keeps its id so jumps through it point at the saved one.
    if let Some(e) = existing {
        machine.id = e.id;
    }
    ImportRow {
        label,
        machine,
        key,
        existing: existing.is_some(),
        auth_note,
        via: None,
    }
}

/// The first default key Tether can use, else the agent with the reason the nearest one was
/// skipped. A missing default is no reason: OpenSSH skips it silently too.
fn default_key(
    paths: &[PathBuf],
    keys: &KeyRecords,
    read: &dyn Fn(&Path) -> Option<String>,
) -> (Auth, Option<ImportKey>, String) {
    let mut fallback = None;
    for path in paths.iter().filter(|p| read(p).is_some()) {
        let found = key_for(Some(path), keys, read);
        if matches!(found.0, Auth::Key { .. }) {
            return found;
        }
        fallback.get_or_insert(found);
    }
    fallback.unwrap_or_else(|| key_for(None, keys, read))
}

fn key_for(
    path: Option<&Path>,
    keys: &KeyRecords,
    read: &dyn Fn(&Path) -> Option<String>,
) -> (Auth, Option<ImportKey>, String) {
    let Some(path) = path else {
        return (Auth::Agent, None, "agent".into());
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "imported".into());
    let Some(private) = read(path).map(Zeroizing::new) else {
        return (Auth::Agent, None, format!("agent ({name} not found)"));
    };
    if is_encrypted(&private) {
        return (
            Auth::Agent,
            None,
            format!("agent ({name} has a passphrase)"),
        );
    }
    let public_line = match derive_public_line(&private) {
        Ok(line) => line,
        Err(_) => {
            return (
                Auth::Agent,
                None,
                format!("agent ({name} isn't a key Tether reads)"),
            );
        }
    };
    let print = fingerprint(&public_line);
    if let Some(k) = keys
        .keys
        .iter()
        .find(|k| Some(&k.fingerprint) == print.as_ref())
    {
        return (Auth::Key { id: k.id }, None, format!("key {}", k.name));
    }
    let id = Uuid::new_v4();
    let key = ImportKey {
        id,
        name: name.clone(),
        private: Zeroizing::new(normalize_pem(&private)),
        public_line,
    };
    (Auth::Key { id }, Some(key), format!("key {name}"))
}

/// The chosen rows, plus every row they jump through that is not already saved.
pub fn with_jumps(rows: &[ImportRow], chosen: &[usize]) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    for &i in chosen {
        let mut next = Some(i);
        let mut guard = 0;
        while let Some(at) = next {
            if !out.contains(&at) && !rows[at].existing {
                out.push(at);
            }
            guard += 1;
            next = rows[at]
                .machine
                .jump
                .and_then(|j| rows.iter().position(|r| r.machine.id == j))
                .filter(|_| guard <= crate::connect::MAX_JUMPS);
        }
    }
    out.sort_unstable();
    out
}

/// Keys shared by several rows are brought in once.
pub fn keys_to_add<'a>(rows: &'a [ImportRow], picked: &[usize]) -> Vec<&'a ImportKey> {
    let mut out: Vec<&ImportKey> = Vec::new();
    for &i in picked {
        if let Some(k) = &rows[i].key
            && !out.iter().any(|o| o.public_line == k.public_line)
        {
            out.push(k);
        }
    }
    out
}

/// Machines that point at a key brought in by another row use that row's key id.
pub fn machines_to_add(rows: &[ImportRow], picked: &[usize]) -> Vec<Machine> {
    let keys = keys_to_add(rows, picked);
    picked
        .iter()
        .map(|&i| {
            let mut m = rows[i].machine.clone();
            if let Some(k) = &rows[i].key
                && let Some(kept) = keys.iter().find(|o| o.public_line == k.public_line)
            {
                m.auth = Auth::Key { id: kept.id };
            }
            m
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{KeyOrigin, KeyRecord, generate_ed25519, import_record};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn host(alias: &str, hostname: &str, user: Option<&str>, jumps: &[&str]) -> ConfigHost {
        ConfigHost {
            alias: alias.into(),
            host: hostname.into(),
            port: 22,
            user: user.map(Into::into),
            identity_file: None,
            jumps: jumps.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn none(_: &Path) -> Option<String> {
        None
    }

    #[test]
    fn hosts_become_machines_with_the_default_user_and_agent() {
        let rows = plan(
            &[host("devbox", "10.0.0.5", None, &[])],
            &[],
            &KeyRecords::default(),
            "winuser",
            &[],
            &none,
        );
        assert_eq!(rows.len(), 1);
        let m = &rows[0].machine;
        assert_eq!(
            (m.name.as_str(), m.host.as_str(), m.user.as_str()),
            ("devbox", "10.0.0.5", "winuser")
        );
        assert_eq!(m.auth, Auth::Agent);
        assert!(!rows[0].existing);
    }

    #[test]
    fn proxy_jump_aliases_link_rows_and_unknown_hops_get_their_own_row() {
        let rows = plan(
            &[
                host("bastion", "b.example", Some("j"), &[]),
                host("inner", "10.1.0.2", Some("u"), &["bastion"]),
                host("deep", "10.2.0.2", Some("u"), &["me@edge:2200", "bastion"]),
            ],
            &[],
            &KeyRecords::default(),
            "w",
            &[],
            &none,
        );
        let by = |l: &str| rows.iter().find(|r| r.label == l).unwrap();
        assert_eq!(by("inner").machine.jump, Some(by("bastion").machine.id));
        assert_eq!(by("inner").via.as_deref(), Some("bastion"));
        let edge = by("me@edge:2200");
        assert_eq!(
            (edge.machine.user.as_str(), edge.machine.port),
            ("me", 2200)
        );
        assert_eq!(by("deep").machine.jump, Some(by("bastion").machine.id));
        assert_eq!(rows.len(), 4);
    }

    #[test]
    fn a_saved_endpoint_is_marked_and_keeps_its_id() {
        let saved = Machine {
            id: Uuid::from_u128(5),
            name: "old name".into(),
            host: "B.example".into(),
            port: 22,
            user: "j".into(),
            auth: Auth::Agent,
            jump: None,
        };
        let rows = plan(
            &[
                host("bastion", "b.example", Some("j"), &[]),
                host("inner", "10.1.0.2", Some("u"), &["bastion"]),
            ],
            std::slice::from_ref(&saved),
            &KeyRecords::default(),
            "w",
            &[],
            &none,
        );
        assert!(rows[0].existing);
        assert_eq!(rows[1].machine.jump, Some(saved.id));
        assert_eq!(
            with_jumps(&rows, &[1]),
            [1],
            "the saved jump is not added again"
        );
    }

    #[test]
    fn choosing_a_host_brings_its_unsaved_jumps() {
        let rows = plan(
            &[
                host("bastion", "b", Some("j"), &[]),
                host("inner", "i", Some("u"), &["bastion"]),
            ],
            &[],
            &KeyRecords::default(),
            "w",
            &[],
            &none,
        );
        assert_eq!(with_jumps(&rows, &[1]), [0, 1]);
    }

    #[test]
    fn identity_files_import_once_reuse_vault_keys_and_skip_encrypted_ones() {
        let (_, pem) = generate_ed25519("k", 0);
        let public = derive_public_line(&pem).unwrap();
        let (_, other_pem) = generate_ed25519("vault", 0);
        let vault_public = derive_public_line(&other_pem).unwrap();
        let vault: KeyRecord = import_record("mine", &vault_public, KeyOrigin::Imported, 0);
        let files: HashMap<PathBuf, String> = HashMap::from([
            (PathBuf::from("/k/id_a"), pem.to_string()),
            (PathBuf::from("/k/id_vault"), other_pem.to_string()),
            (
                PathBuf::from("/k/id_locked"),
                "-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n"
                    .into(),
            ),
        ]);
        let read = |p: &Path| files.get(p).cloned();
        let with = |alias: &str, file: &str| ConfigHost {
            identity_file: Some(PathBuf::from(file)),
            ..host(alias, alias, Some("u"), &[])
        };
        let keys = KeyRecords {
            keys: vec![vault.clone()],
        };
        let rows = plan(
            &[
                with("a1", "/k/id_a"),
                with("a2", "/k/id_a"),
                with("v", "/k/id_vault"),
                with("l", "/k/id_locked"),
                with("gone", "/k/missing"),
            ],
            &[],
            &keys,
            "w",
            &[],
            &read,
        );
        let picked = [0, 1, 2, 3, 4];
        let added = keys_to_add(&rows, &picked);
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].public_line, public);
        let machines = machines_to_add(&rows, &picked);
        assert_eq!(machines[0].auth, machines[1].auth, "one key, both machines");
        assert_eq!(machines[2].auth, Auth::Key { id: vault.id });
        assert_eq!(machines[3].auth, Auth::Agent);
        assert_eq!(rows[3].auth_note, "agent (id_locked has a passphrase)");
        assert_eq!(machines[4].auth, Auth::Agent);
        assert_eq!(rows[4].auth_note, "agent (missing not found)");
    }

    #[test]
    fn without_an_identity_file_the_first_usable_default_key_is_used() {
        let (_, pem) = generate_ed25519("k", 0);
        let public = derive_public_line(&pem).unwrap();
        let defaults = default_identity_files(Path::new("h"));
        let files: HashMap<PathBuf, String> = HashMap::from([
            (
                defaults[0].clone(),
                "-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n"
                    .into(),
            ),
            (defaults[2].clone(), pem.to_string()),
        ]);
        let read = |p: &Path| files.get(p).cloned();
        let rows = plan(
            &[host("inner", "10.1.0.2", Some("u"), &["me@edge"])],
            &[],
            &KeyRecords::default(),
            "w",
            &defaults,
            &read,
        );
        for r in &rows {
            assert_eq!(r.auth_note, "key id_rsa", "{}", r.label);
            assert!(matches!(r.machine.auth, Auth::Key { .. }));
        }
        let picked = [0, 1];
        assert_eq!(keys_to_add(&rows, &picked).len(), 1);
        assert_eq!(keys_to_add(&rows, &picked)[0].public_line, public);
    }

    #[test]
    fn without_an_identity_file_or_usable_default_key_the_agent_is_used() {
        let locked =
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n";
        let defaults = default_identity_files(Path::new("h"));
        let read = |p: &Path| (p == defaults[0]).then(|| locked.to_string());
        let rows = plan(
            &[host("box", "b", None, &[])],
            &[],
            &KeyRecords::default(),
            "w",
            &defaults,
            &read,
        );
        assert_eq!(rows[0].machine.auth, Auth::Agent);
        assert_eq!(rows[0].auth_note, "agent (id_ed25519 has a passphrase)");
        let rows = plan(
            &[host("box", "b", None, &[])],
            &[],
            &KeyRecords::default(),
            "w",
            &defaults,
            &none,
        );
        assert_eq!(rows[0].auth_note, "agent");
    }
}
