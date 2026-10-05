use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

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

pub(crate) fn ssh_string(out: &mut Vec<u8>, data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
}

pub(crate) fn line_from_blob(blob: &[u8], algorithm: &str, comment: Option<&str>) -> String {
    let mut line = format!("{algorithm} {}", STANDARD.encode(blob));
    if let Some(c) = comment.filter(|c| !c.is_empty()) {
        line.push(' ');
        line.push_str(c);
    }
    line
}

pub fn openssh_ed25519_line(public: &[u8; 32], comment: Option<&str>) -> String {
    let mut blob = Vec::with_capacity(51);
    ssh_string(&mut blob, b"ssh-ed25519");
    ssh_string(&mut blob, public);
    line_from_blob(&blob, "ssh-ed25519", comment)
}

/// RFC 8410 one-asymmetric-key wrapping of a raw seed, the same bytes iOS writes.
pub fn pkcs8_pem_ed25519(seed: &[u8; 32]) -> Zeroizing<String> {
    const PREFIX: [u8; 16] = [
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ];
    let mut der = Zeroizing::new(Vec::with_capacity(48));
    der.extend_from_slice(&PREFIX);
    der.extend_from_slice(seed);
    let body = Zeroizing::new(STANDARD.encode(der.as_slice()));
    let mut pem = Zeroizing::new(String::from("-----BEGIN PRIVATE KEY-----\n"));
    for chunk in body.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap());
        pem.push('\n');
    }
    pem.push_str("-----END PRIVATE KEY-----\n");
    pem
}

pub fn generate_ed25519(name: &str, now: i64) -> (KeyRecord, Zeroizing<String>) {
    let signing = ed25519_dalek::SigningKey::generate(&mut rand_core::OsRng);
    let seed = Zeroizing::new(signing.to_bytes());
    let public_line = openssh_ed25519_line(&signing.verifying_key().to_bytes(), Some(name));
    let record = KeyRecord {
        id: Uuid::new_v4(),
        name: name.to_string(),
        algorithm: "ssh-ed25519".into(),
        fingerprint: fingerprint(&public_line).unwrap_or_default(),
        public_line,
        origin: KeyOrigin::Generated,
        created: now,
    };
    (record, pkcs8_pem_ed25519(&seed))
}

pub fn algorithm_of(public_line: &str) -> Option<&str> {
    public_line.split_whitespace().next()
}

fn public_blob(public_line: &str) -> Option<Vec<u8>> {
    let b64 = public_line.split_whitespace().nth(1)?;
    STANDARD.decode(b64).ok()
}

pub fn fingerprint_digest(public_line: &str) -> Option<[u8; 32]> {
    Some(Sha256::digest(public_blob(public_line)?).into())
}

pub fn fingerprint(public_line: &str) -> Option<String> {
    Some(format!("SHA256:{}", STANDARD_NO_PAD.encode(fingerprint_digest(public_line)?)))
}

pub fn short_fingerprint(fingerprint: &str) -> String {
    let body = fingerprint.strip_prefix("SHA256:").unwrap_or(fingerprint);
    let chars: Vec<char> = body.chars().collect();
    if chars.len() <= 16 {
        return fingerprint.to_string();
    }
    let head: String = chars[..8].iter().collect();
    let tail: String = chars[chars.len() - 6..].iter().collect();
    format!("SHA256:{head}…{tail}")
}

/// OpenSSH's drunken-bishop walk, ported from iOS `SSHRandomart`.
pub fn randomart(digest: &[u8]) -> [[u8; 17]; 9] {
    const W: i32 = 17;
    const H: i32 = 9;
    let mut field = [[0u8; 17]; 9];
    let (mut x, mut y) = (W / 2, H / 2);
    for &byte in digest {
        let mut bits = byte;
        for _ in 0..4 {
            x += if bits & 1 == 1 { 1 } else { -1 };
            y += if bits & 2 == 2 { 1 } else { -1 };
            x = x.clamp(0, W - 1);
            y = y.clamp(0, H - 1);
            let cell = &mut field[y as usize][x as usize];
            if *cell < 14 {
                *cell += 1;
            }
            bits >>= 2;
        }
    }
    field[(H / 2) as usize][(W / 2) as usize] = 15;
    field[y as usize][x as usize] = 16;
    field
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

#[cfg(test)]
mod encoding_tests {
    use super::*;

    const SEED: [u8; 32] = [
        0x0b, 0x8a, 0x44, 0x0c, 0x22, 0x48, 0x54, 0xfb, 0x4f, 0x88, 0x1b, 0x1b, 0xed, 0x94, 0x74, 0x57,
        0xf9, 0x89, 0x5f, 0x09, 0xbc, 0x28, 0xe8, 0xf0, 0xe8, 0xfb, 0xff, 0x54, 0x36, 0x87, 0x70, 0x1b,
    ];
    const PUB: [u8; 32] = [
        0xba, 0xbf, 0x04, 0x3b, 0xfb, 0x1a, 0x9f, 0xf5, 0xc3, 0x30, 0x4c, 0x17, 0xe0, 0xef, 0x11, 0x7e,
        0xa6, 0x58, 0x92, 0x11, 0xd0, 0xdf, 0x15, 0xc0, 0x10, 0xe8, 0x36, 0x2c, 0x8c, 0x71, 0x17, 0xf3,
    ];
    const LINE: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILq/BDv7Gp/1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfz";
    const FP: &str = "SHA256:qQubUJmzqluQ5lmjKUy3awN04Qv0ts1nr4pZWS2gI8o";

    #[test]
    fn builds_the_openssh_line_with_and_without_comment() {
        assert_eq!(openssh_ed25519_line(&PUB, None), LINE);
        assert_eq!(openssh_ed25519_line(&PUB, Some("me@pc")), format!("{LINE} me@pc"));
        assert_eq!(openssh_ed25519_line(&PUB, Some("")), LINE);
    }

    #[test]
    fn wraps_the_seed_as_pkcs8_pem() {
        let pem = pkcs8_pem_ed25519(&SEED);
        assert!(pem.starts_with("-----BEGIN PRIVATE KEY-----\n"));
        assert!(pem.contains("MC4CAQAwBQYDK2VwBCIEIAuKRAwiSFT7T4gbG+2UdFf5iV8JvCjo8Oj7/1Q2h3Ab"));
        assert!(pem.ends_with("-----END PRIVATE KEY-----\n"));
    }

    #[test]
    fn fingerprint_matches_ssh_keygen() {
        assert_eq!(fingerprint(LINE).as_deref(), Some(FP));
        assert_eq!(fingerprint(&format!("{LINE} comment")).as_deref(), Some(FP));
        assert_eq!(fingerprint("ssh-ed25519"), None);
        assert_eq!(fingerprint("ssh-ed25519 !!!notbase64"), None);
    }

    #[test]
    fn algorithm_is_the_first_token() {
        assert_eq!(algorithm_of(LINE), Some("ssh-ed25519"));
        assert_eq!(algorithm_of("  ssh-rsa AAAAB3 x"), Some("ssh-rsa"));
        assert_eq!(algorithm_of("ecdsa-sha2-nistp256 AAAAE2"), Some("ecdsa-sha2-nistp256"));
        assert_eq!(algorithm_of("   "), None);
    }

    #[test]
    fn short_fingerprint_follows_the_ios_card() {
        assert_eq!(short_fingerprint(FP), "SHA256:qQubUJmz…S2gI8o");
        assert_eq!(short_fingerprint("SHA256:abc"), "SHA256:abc");
    }

    #[test]
    fn randomart_matches_ssh_keygen_drunken_bishop() {
        let digest = fingerprint_digest(LINE).unwrap();
        let glyphs: Vec<char> = " .o+=*BOX@%&#/^SE".chars().collect();
        let expected = [
            "                 ",
            " . .             ",
            ". o ..           ",
            " + =.o. ..       ",
            "+++*X  oS.       ",
            "BoB++=o+.        ",
            "oE+.oo+ .        ",
            ".. ==+ . .       ",
            "ooo++.o..        ",
        ];
        let rows: Vec<String> = randomart(&digest)
            .iter()
            .map(|row| row.iter().map(|&v| glyphs[v as usize]).collect())
            .collect();
        assert_eq!(rows, expected);
    }

    #[test]
    fn generated_key_round_trips_through_pkcs8_and_signs() {
        use ed25519_dalek::pkcs8::DecodePrivateKey;
        use ed25519_dalek::{Signer, Verifier, VerifyingKey};

        let (record, pem) = generate_ed25519("laptop", 1_791_082_819);
        assert_eq!(record.algorithm, "ssh-ed25519");
        assert_eq!(record.origin, KeyOrigin::Generated);
        assert_eq!(record.created, 1_791_082_819);
        assert_eq!(record.name, "laptop");
        assert!(record.public_line.ends_with(" laptop"));
        assert_eq!(fingerprint(&record.public_line).unwrap(), record.fingerprint);

        let signing = ed25519_dalek::SigningKey::from_pkcs8_pem(&pem).unwrap();
        let blob = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            record.public_line.split_whitespace().nth(1).unwrap(),
        )
        .unwrap();
        let public: [u8; 32] = blob[blob.len() - 32..].try_into().unwrap();
        let verifying = VerifyingKey::from_bytes(&public).unwrap();
        let sig = signing.sign(b"tether");
        assert!(verifying.verify(b"tether", &sig).is_ok());
    }
}
