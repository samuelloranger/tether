use chrono::{DateTime, Local, NaiveDate};
use tether_core::{
    KeyRecord, KeyRecords, Machine, Profiles,
    chrome::ChromePalette,
    fingerprint_digest,
    profiles::{delete_key_warning, keys_subtitle, machines_subtitle, used_by_line},
    randomart, short_fingerprint,
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeTab {
    Machines,
    Keys,
}

impl HomeTab {
    pub fn index(self) -> i32 {
        match self {
            HomeTab::Machines => 0,
            HomeTab::Keys => 1,
        }
    }

    pub fn from_index(i: i32) -> Self {
        if i == 1 {
            HomeTab::Keys
        } else {
            HomeTab::Machines
        }
    }
}

pub fn subtitle(tab: HomeTab, profiles: &Profiles, keys: &KeyRecords) -> String {
    match tab {
        HomeTab::Machines => machines_subtitle(profiles.machines.len()),
        HomeTab::Keys => keys_subtitle(keys.keys.len()),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MachineCardVm {
    pub id: Uuid,
    pub name: String,
    pub address: String,
    pub auth: String,
    pub key_missing: bool,
}

pub fn machine_cards(profiles: &Profiles, keys: &KeyRecords) -> Vec<MachineCardVm> {
    profiles
        .machines
        .iter()
        .map(|m| MachineCardVm {
            id: m.id,
            name: m.name.clone(),
            address: format!("{}@{}:{}", m.user, m.host, m.port),
            auth: match m.jump {
                None => m.auth_label(keys),
                Some(j) => {
                    let via = profiles
                        .get(j)
                        .map_or("a removed machine", |h| h.name.as_str());
                    format!("{} · via {via}", m.auth_label(keys))
                }
            },
            key_missing: m.key_missing(keys),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyCardVm {
    pub id: Uuid,
    pub name: String,
    pub origin: &'static str,
    pub meta: String,
    pub fingerprint: String,
    pub usage: String,
    pub public_line: String,
}

pub fn created_label(date: NaiveDate) -> String {
    format!("created {}", date.format("%b %-d"))
}

pub fn local_date(unix: i64) -> NaiveDate {
    DateTime::from_timestamp(unix, 0)
        .map(|t| t.with_timezone(&Local).date_naive())
        .unwrap_or_default()
}

pub fn key_cards(
    keys: &KeyRecords,
    profiles: &Profiles,
    date_of: impl Fn(i64) -> NaiveDate,
) -> Vec<KeyCardVm> {
    keys.keys
        .iter()
        .map(|k| KeyCardVm {
            id: k.id,
            name: k.name.clone(),
            origin: k.origin.label(),
            meta: format!("{} · {}", k.algorithm, created_label(date_of(k.created))),
            fingerprint: short_fingerprint(&k.fingerprint),
            usage: used_by_line(&profiles.using_key(k.id)),
            public_line: k.public_line.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct DialogCopy {
    pub title: String,
    pub body: &'static str,
    pub extra: Option<String>,
    pub action: &'static str,
}

pub fn remove_machine_copy(m: &Machine) -> DialogCopy {
    DialogCopy {
        title: format!("Remove {}?", m.name),
        body: "Its sessions keep running on the host — only this PC forgets it.",
        extra: None,
        action: "Remove machine",
    }
}

pub fn delete_key_copy(k: &KeyRecord, profiles: &Profiles) -> DialogCopy {
    DialogCopy {
        title: format!("Delete key {}?", k.name),
        body: "The private key is erased from this PC and cannot be recovered.",
        extra: delete_key_warning(&profiles.using_key(k.id)),
        action: "Delete key",
    }
}

pub const ART_CELL: u32 = 8;
pub const ART_GAP: u32 = 2;
pub const ART_WIDTH: u32 = 17 * ART_CELL + 16 * ART_GAP;
pub const ART_HEIGHT: u32 = 9 * ART_CELL + 8 * ART_GAP;

pub fn art_color(count: u8, chrome: &ChromePalette) -> Option<[u8; 4]> {
    let rgb = |c: u32| [(c >> 16) as u8, (c >> 8) as u8, c as u8];
    let (accent, success, warning, danger) = (
        rgb(chrome.accent),
        rgb(chrome.success),
        rgb(chrome.warning),
        rgb(chrome.danger),
    );
    let (rgb, alpha) = match count {
        0 => return None,
        1..=2 => (accent, 89),
        3..=5 => (accent, 255),
        6..=9 => (success, 255),
        10..=14 => (warning, 255),
        15 => (accent, 255),
        _ => (danger, 255),
    };
    Some([rgb[0], rgb[1], rgb[2], alpha])
}

pub fn randomart_rgba(public_line: &str, chrome: &ChromePalette) -> Vec<u8> {
    let mut px = vec![0u8; (ART_WIDTH * ART_HEIGHT * 4) as usize];
    let Some(digest) = fingerprint_digest(public_line) else {
        return px;
    };
    for (row, counts) in randomart(&digest).iter().enumerate() {
        for (col, &count) in counts.iter().enumerate() {
            let Some(color) = art_color(count, chrome) else {
                continue;
            };
            let (x0, y0) = (
                col as u32 * (ART_CELL + ART_GAP),
                row as u32 * (ART_CELL + ART_GAP),
            );
            for y in y0..y0 + ART_CELL {
                for x in x0..x0 + ART_CELL {
                    let at = ((y * ART_WIDTH + x) * 4) as usize;
                    px[at..at + 4].copy_from_slice(&color);
                }
            }
        }
    }
    px
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_machine_reached_through_another_names_it() {
        let mut bastion = machine(1, "bastion", Auth::Agent);
        bastion.jump = None;
        let mut inner = machine(2, "inner", Auth::Agent);
        inner.jump = Some(bastion.id);
        let mut orphan = machine(3, "orphan", Auth::Agent);
        orphan.jump = Some(Uuid::from_u128(99));
        let profiles = Profiles {
            machines: vec![bastion, inner, orphan],
        };
        let cards = machine_cards(&profiles, &KeyRecords::default());
        assert_eq!(cards[0].auth, "agent");
        assert_eq!(cards[1].auth, "agent · via bastion");
        assert_eq!(cards[2].auth, "agent · via a removed machine");
    }

    use super::*;
    use tether_core::{Auth, KeyOrigin, theme_named};

    const PUBLIC: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILq/BDv7Gp/1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfz work";

    fn key(id: u128, name: &str) -> KeyRecord {
        KeyRecord {
            id: Uuid::from_u128(id),
            name: name.into(),
            algorithm: "ssh-ed25519".into(),
            public_line: PUBLIC.into(),
            fingerprint: "SHA256:Lq/BDv7Gp1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfzA".into(),
            origin: KeyOrigin::Generated,
            created: 0,
        }
    }

    fn machine(id: u128, name: &str, auth: Auth) -> Machine {
        Machine {
            id: Uuid::from_u128(id),
            name: name.into(),
            host: "192.0.2.10".into(),
            port: 22,
            user: "dev".into(),
            auth,
            jump: None,
        }
    }

    #[test]
    fn subtitle_follows_the_tab() {
        let profiles = Profiles {
            machines: vec![
                machine(1, "devbox", Auth::Agent),
                machine(2, "vps", Auth::Password),
            ],
        };
        let keys = KeyRecords {
            keys: vec![key(9, "id_ed25519")],
        };
        assert_eq!(subtitle(HomeTab::Machines, &profiles, &keys), "2 machines");
        assert_eq!(
            subtitle(HomeTab::Keys, &profiles, &keys),
            "1 key · on this PC"
        );
        assert_eq!(
            subtitle(HomeTab::Machines, &Profiles::default(), &keys),
            "no machines yet"
        );
    }

    #[test]
    fn machine_card_splits_address_and_auth() {
        let keys = KeyRecords {
            keys: vec![key(9, "id_ed25519")],
        };
        let profiles = Profiles {
            machines: vec![
                machine(
                    1,
                    "devbox",
                    Auth::Key {
                        id: Uuid::from_u128(9),
                    },
                ),
                machine(
                    2,
                    "old",
                    Auth::Key {
                        id: Uuid::from_u128(8),
                    },
                ),
            ],
        };
        let cards = machine_cards(&profiles, &keys);
        assert_eq!(cards[0].address, "dev@192.0.2.10:22");
        assert_eq!(cards[0].auth, "id_ed25519");
        assert!(!cards[0].key_missing);
        assert_eq!(cards[1].auth, "key missing");
        assert!(cards[1].key_missing);
    }

    #[test]
    fn key_card_lines() {
        let keys = KeyRecords {
            keys: vec![key(9, "id_ed25519")],
        };
        let profiles = Profiles {
            machines: vec![machine(
                1,
                "devbox",
                Auth::Key {
                    id: Uuid::from_u128(9),
                },
            )],
        };
        let card = &key_cards(&keys, &profiles, |_| {
            NaiveDate::from_ymd_opt(2026, 10, 5).unwrap()
        })[0];
        assert_eq!(card.origin, "generated");
        assert_eq!(card.meta, "ssh-ed25519 · created Oct 5");
        assert_eq!(card.fingerprint, "SHA256:Lq/BDv7G…McRfzA");
        assert_eq!(card.usage, "used by devbox");
        let unused = &key_cards(&keys, &Profiles::default(), |_| NaiveDate::default())[0];
        assert_eq!(unused.usage, "not used yet");
    }

    #[test]
    fn remove_machine_dialog_copy() {
        let copy = remove_machine_copy(&machine(1, "devbox", Auth::Agent));
        assert_eq!(copy.title, "Remove devbox?");
        assert_eq!(
            copy.body,
            "Its sessions keep running on the host — only this PC forgets it."
        );
        assert_eq!(copy.extra, None);
        assert_eq!(copy.action, "Remove machine");
    }

    #[test]
    fn delete_key_dialog_names_the_machines_that_lose_it() {
        let k = key(9, "id_ed25519");
        let profiles = Profiles {
            machines: vec![machine(1, "devbox", Auth::Key { id: k.id })],
        };
        let copy = delete_key_copy(&k, &profiles);
        assert_eq!(copy.title, "Delete key id_ed25519?");
        assert_eq!(
            copy.body,
            "The private key is erased from this PC and cannot be recovered."
        );
        assert_eq!(
            copy.extra.as_deref(),
            Some("devbox won't be able to sign in until it gets another key.")
        );
        assert_eq!(copy.action, "Delete key");
        assert_eq!(delete_key_copy(&k, &Profiles::default()).extra, None);
    }

    #[test]
    fn art_colors_come_from_the_chrome_palette() {
        let c = theme_named("dracula").chrome();
        let rgb = |v: u32| [(v >> 16) as u8, (v >> 8) as u8, v as u8];
        let with = |v: u32, a: u8| {
            let [r, g, b] = rgb(v);
            Some([r, g, b, a])
        };
        assert_ne!(c.accent, theme_named("tether").chrome().accent);
        assert_eq!(art_color(0, &c), None);
        assert_eq!(art_color(1, &c), with(c.accent, 89));
        assert_eq!(art_color(4, &c), with(c.accent, 255));
        assert_eq!(art_color(7, &c), with(c.success, 255));
        assert_eq!(art_color(12, &c), with(c.warning, 255));
        assert_eq!(art_color(15, &c), with(c.accent, 255));
        assert_eq!(art_color(16, &c), with(c.danger, 255));
    }

    #[test]
    fn randomart_buffer_has_the_end_cell_in_danger() {
        let px = randomart_rgba(PUBLIC, &theme_named("tether").chrome());
        assert_eq!(px.len(), (ART_WIDTH * ART_HEIGHT * 4) as usize);
        let field = randomart(&fingerprint_digest(PUBLIC).unwrap());
        let (row, col) = (0..9)
            .flat_map(|r| (0..17).map(move |c| (r, c)))
            .find(|&(r, c)| field[r][c] == 16)
            .unwrap();
        let (x, y) = (
            col as u32 * (ART_CELL + ART_GAP),
            row as u32 * (ART_CELL + ART_GAP),
        );
        let at = ((y * ART_WIDTH + x) * 4) as usize;
        assert_eq!(&px[at..at + 4], &[0xFF, 0x70, 0x50, 255]);
        let gap = (ART_CELL * 4) as usize;
        assert_eq!(px[gap + 3], 0);
    }

    #[test]
    fn unparsable_public_line_draws_an_empty_field() {
        assert!(
            randomart_rgba("not a key", &theme_named("tether").chrome())
                .iter()
                .all(|&b| b == 0)
        );
    }
}
