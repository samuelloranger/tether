use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const KEYS_FILE: &str = "keys.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyOrigin {
    Generated,
    Imported,
    Pasted,
}

impl KeyOrigin {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Generated => "generated",
            Self::Imported => "imported",
            Self::Pasted => "pasted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyRecord {
    pub id: Uuid,
    pub name: String,
    pub algorithm: String,
    pub public_line: String,
    pub fingerprint: String,
    pub origin: KeyOrigin,
    /// Unix seconds.
    pub created: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct KeyRecords {
    pub keys: Vec<KeyRecord>,
}

impl KeyRecords {
    pub fn get(&self, id: Uuid) -> Option<&KeyRecord> {
        self.keys.iter().find(|k| k.id == id)
    }

    pub fn add(&mut self, record: KeyRecord) {
        self.keys.push(record);
    }

    pub fn remove(&mut self, id: Uuid) -> Option<KeyRecord> {
        let at = self.keys.iter().position(|k| k.id == id)?;
        Some(self.keys.remove(at))
    }
}

#[cfg(test)]
mod record_tests {
    use super::*;

    #[test]
    fn origin_serializes_lowercase_and_labels_match_the_capsule() {
        assert_eq!(serde_json::to_string(&KeyOrigin::Pasted).unwrap(), "\"pasted\"");
        assert_eq!(KeyOrigin::Generated.label(), "generated");
        assert_eq!(KeyOrigin::Imported.label(), "imported");
    }

    #[test]
    fn records_add_and_remove() {
        let mut r = KeyRecords::default();
        let rec = KeyRecord {
            id: Uuid::from_u128(1),
            name: "k".into(),
            algorithm: "ssh-rsa".into(),
            public_line: "ssh-rsa AAAA".into(),
            fingerprint: "SHA256:x".into(),
            origin: KeyOrigin::Imported,
            created: 1_791_082_819,
        };
        r.add(rec.clone());
        assert_eq!(r.get(rec.id), Some(&rec));
        assert_eq!(r.remove(rec.id), Some(rec.clone()));
        assert_eq!(r.get(rec.id), None);
    }
}
