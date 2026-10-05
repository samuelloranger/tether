use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use tether_core::{KeyForm, KeyOrigin, generate_hint};

pub const MAX_KEY_FILE: u64 = 64 * 1024;

pub struct LoadedKeyFile {
    pub private: String,
    pub name: Option<String>,
    pub public: Option<String>,
}

fn read_small_text(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_KEY_FILE + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_KEY_FILE {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub fn load_key_file(path: &Path) -> Option<LoadedKeyFile> {
    let private = read_small_text(path)?;
    let mut pub_path = path.as_os_str().to_owned();
    pub_path.push(".pub");
    let public = read_small_text(&PathBuf::from(pub_path)).map(|s| s.trim().to_owned());
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    Some(LoadedKeyFile {
        private,
        name,
        public,
    })
}

pub fn apply_loaded(form: &mut KeyForm, loaded: LoadedKeyFile) {
    form.private = loaded.private;
    if form.name.trim().is_empty() {
        if let Some(name) = loaded.name {
            form.name = name;
        }
    }
    if let Some(public) = loaded.public {
        form.public = public;
    }
}

#[derive(Default)]
pub struct GenerateVm {
    pub name: String,
    pub error: Option<String>,
}

impl GenerateVm {
    pub fn hint(&self) -> String {
        self.error
            .clone()
            .or_else(|| generate_hint(&self.name).map(str::to_owned))
            .unwrap_or_default()
    }

    pub fn can_save(&self) -> bool {
        generate_hint(&self.name).is_none()
    }
}

pub struct KeyMaterialVm {
    pub origin: KeyOrigin,
    pub form: KeyForm,
    pub error: Option<String>,
}

impl KeyMaterialVm {
    pub fn new(origin: KeyOrigin) -> Self {
        Self {
            origin,
            form: KeyForm {
                name: String::new(),
                private: String::new(),
                public: String::new(),
            },
            error: None,
        }
    }

    pub fn title(&self) -> &'static str {
        if self.origin == KeyOrigin::Imported {
            "Import key"
        } else {
            "Paste key"
        }
    }

    pub fn show_file_button(&self) -> bool {
        self.origin == KeyOrigin::Imported
    }

    pub fn apply(&mut self, name: String, private: String, public: String) {
        self.form = KeyForm {
            name,
            private,
            public,
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
    use std::fs;

    #[test]
    fn loading_fills_private_name_and_sibling_pub() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        fs::write(
            &path,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("id_ed25519.pub"),
            "ssh-ed25519 AAAA me@pc\n",
        )
        .unwrap();
        let loaded = load_key_file(&path).unwrap();
        assert!(loaded.private.contains("OPENSSH PRIVATE KEY"));
        assert_eq!(loaded.name.as_deref(), Some("id_ed25519"));
        assert_eq!(loaded.public.as_deref(), Some("ssh-ed25519 AAAA me@pc"));
    }

    #[test]
    fn base_name_drops_the_extension_and_pub_is_optional() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("work.pem");
        fs::write(&path, "-----BEGIN RSA PRIVATE KEY-----\n").unwrap();
        let loaded = load_key_file(&path).unwrap();
        assert_eq!(loaded.name.as_deref(), Some("work"));
        assert_eq!(loaded.public, None);
    }

    #[test]
    fn huge_or_binary_files_load_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("disk.iso");
        fs::write(&big, vec![b'a'; MAX_KEY_FILE as usize + 1]).unwrap();
        assert!(load_key_file(&big).is_none());
        let binary = dir.path().join("key.ppk");
        fs::write(&binary, [0xFF, 0xFE, 0x00, 0x9F]).unwrap();
        assert!(load_key_file(&binary).is_none());
        assert!(load_key_file(dir.path()).is_none());
    }

    #[test]
    fn apply_loaded_keeps_a_typed_name() {
        let mut form = KeyForm {
            name: "laptop".into(),
            private: String::new(),
            public: "old".into(),
        };
        apply_loaded(
            &mut form,
            LoadedKeyFile {
                private: "P".into(),
                name: Some("id_rsa".into()),
                public: Some("ssh-rsa X".into()),
            },
        );
        assert_eq!(
            (
                form.name.as_str(),
                form.private.as_str(),
                form.public.as_str()
            ),
            ("laptop", "P", "ssh-rsa X")
        );
        let mut blank = KeyForm {
            name: "  ".into(),
            private: String::new(),
            public: "kept".into(),
        };
        apply_loaded(
            &mut blank,
            LoadedKeyFile {
                private: "P".into(),
                name: Some("id_rsa".into()),
                public: None,
            },
        );
        assert_eq!(
            (blank.name.as_str(), blank.public.as_str()),
            ("id_rsa", "kept")
        );
    }

    #[test]
    fn generate_needs_a_name() {
        let mut vm = GenerateVm::default();
        assert_eq!(vm.hint(), "Name this key to save it");
        assert!(!vm.can_save());
        vm.name = "desktop".into();
        assert!(vm.can_save());
        assert_eq!(vm.hint(), "");
    }

    #[test]
    fn import_and_paste_titles_and_file_button() {
        let import = KeyMaterialVm::new(KeyOrigin::Imported);
        assert_eq!(import.title(), "Import key");
        assert!(import.show_file_button());
        let paste = KeyMaterialVm::new(KeyOrigin::Pasted);
        assert_eq!(paste.title(), "Paste key");
        assert!(!paste.show_file_button());
        assert_eq!(paste.hint(), "Name this key to save it");
    }

    #[test]
    fn hints_walk_the_form_in_order() {
        let mut vm = KeyMaterialVm::new(KeyOrigin::Pasted);
        vm.apply("work".into(), String::new(), String::new());
        assert_eq!(vm.hint(), "Paste the private key to save it");
        vm.apply(
            "work".into(),
            "-----BEGIN PRIVATE KEY-----".into(),
            "nope".into(),
        );
        assert_eq!(vm.hint(), "Paste the public key to save it");
        vm.error = Some("Couldn't save: x".into());
        assert_eq!(vm.hint(), "Couldn't save: x");
        vm.apply(
            "work".into(),
            "-----BEGIN PRIVATE KEY-----".into(),
            "nope".into(),
        );
        assert_eq!(vm.hint(), "Paste the public key to save it");
    }
}
