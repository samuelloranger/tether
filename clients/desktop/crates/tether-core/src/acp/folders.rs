//! Host folder validation, completion and explicit creation, without an agent process.
use crate::zmx::shell_quote;

const SCRIPT: &str = r###"path=$1
case "$path" in ''|'~') path=$HOME;; '~/'*) path=$HOME/${path#\~/};; esac
while [ "$path" != / ] && [ "${path%/}" != "$path" ]; do path=${path%/}; done
status=invalid
case "$path" in /*) status=missing;; esac
if [ "$status" != invalid ]; then
  if [ "$2" = create ]; then
    if ! mkdir -p -- "$path" 2>/dev/null; then status=create_failed; fi
  fi
  if [ "$status" != create_failed ]; then
    if [ -d "$path" ]; then
      if [ -r "$path" ] && [ -x "$path" ]; then status=ready; else status=denied; fi
    elif [ -e "$path" ] || [ -L "$path" ]; then status=not_directory
    fi
  fi
fi
printf '__TETHER_FOLDER__\000%s\000%s\000' "$status" "$path"
[ "$status" = invalid ] && exit 0
base=$path
prefix=
if [ "$status" != ready ]; then base=${path%/*}; prefix=${path##*/}; fi
[ -n "$base" ] || base=/
[ -r "$base" ] && [ -x "$base" ] && [ -d "$base" ] || exit 0
count=0
for entry in "${base%/}"/* "${base%/}"/.[!.]* "${base%/}"/..?*; do
  [ -d "$entry" ] || continue
  name=${entry##*/}
  case "$name" in "$prefix"*) ;; *) continue;; esac
  printf '%s\000' "$entry"
  count=$((count + 1))
  [ "$count" -lt 200 ] || break
done
exit 0"###;

pub fn command(text: &str, create: bool) -> String {
    format!(
        "sh -c {} tether-folder {} {}",
        shell_quote(SCRIPT),
        shell_quote(text.trim()),
        if create { "create" } else { "check" }
    )
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Folder {
    pub status: String,
    pub path: String,
    pub children: Vec<String>,
}

impl Folder {
    pub fn parse(output: &str) -> Self {
        let Some((_, body)) = output.split_once("__TETHER_FOLDER__\0") else {
            return Self::default();
        };
        let mut parts = body.split('\0');
        let status = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default().to_string();
        if (status != "invalid" && !path.starts_with('/')) || !output.ends_with('\0') {
            return Self::default();
        }
        Self {
            status,
            path,
            children: parts
                .filter(|s| s.starts_with('/'))
                .map(str::to_string)
                .collect(),
        }
    }

    pub fn ready(&self) -> bool {
        self.status == "ready"
    }
    pub fn missing(&self) -> bool {
        self.status == "missing"
    }
    pub fn message(&self) -> &str {
        match self.status.as_str() {
            "ready" => "",
            "missing" => "This folder doesn't exist on the host.",
            "not_directory" => "This path is a file, not a folder.",
            "denied" => "You don't have permission to open this folder.",
            "invalid" => "Enter an absolute path or a path starting with ~/.",
            "create_failed" => {
                "Couldn't create this folder. Check the parent folder and its permissions."
            }
            _ => "Couldn't check the folder on the host. Try again.",
        }
    }
    pub fn parent(&self) -> String {
        self.path
            .rsplit_once('/')
            .map(|(p, _)| if p.is_empty() { "/" } else { p })
            .unwrap_or("/")
            .to_string()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    fn run(text: &str, create: bool) -> Folder {
        let out = Command::new("sh")
            .args(["-c", &command(text, create)])
            .output()
            .unwrap();
        assert!(out.status.success(), "{:?}", out);
        Folder::parse(std::str::from_utf8(&out.stdout).unwrap())
    }

    #[test]
    fn checks_and_completes_literal_host_paths_without_creating_them() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir(dir.path().join("project space")).unwrap();
        fs::create_dir(dir.path().join(".hidden")).unwrap();
        fs::write(dir.path().join("file"), "").unwrap();
        let info = run(root, false);
        assert!(info.ready());
        assert_eq!(info.children.len(), 2);
        let partial = run(&format!("{root}/pro"), false);
        assert!(partial.missing());
        assert_eq!(partial.children, [format!("{root}/project space")]);
        assert!(!dir.path().join("pro").exists());
        assert_eq!(run(&format!("{root}/file"), false).status, "not_directory");
        assert_eq!(run("relative/folder", true).status, "invalid");
    }

    #[test]
    fn creation_quotes_metacharacters_and_reports_failures() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("it's $(touch INJECTED); `true`\n新規/child");
        let text = path.to_str().unwrap();
        assert!(run(text, false).missing());
        assert!(!path.exists());
        assert!(run(text, true).ready());
        assert!(path.is_dir());
        assert!(run(text, true).ready());
        let parent = dir.path().join("file");
        fs::write(&parent, "").unwrap();
        assert_eq!(
            run(parent.join("child").to_str().unwrap(), true).status,
            "create_failed"
        );
    }

    #[test]
    fn home_and_root_are_resolved_on_the_host() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("project")).unwrap();
        let out = Command::new("sh")
            .args(["-c", &command("~/project/", false)])
            .env("HOME", dir.path())
            .output()
            .unwrap();
        assert_eq!(
            Folder::parse(std::str::from_utf8(&out.stdout).unwrap()).path,
            dir.path().join("project").to_str().unwrap()
        );
        assert!(
            run("/", false)
                .children
                .iter()
                .all(|p| !p.starts_with("//"))
        );
    }

    #[test]
    fn malformed_responses_never_enable_start_and_listing_is_bounded() {
        for output in [
            "",
            "ready",
            "__TETHER_FOLDER__\0ready\0relative\0",
            "__TETHER_FOLDER__\0ready\0/tmp",
        ] {
            assert!(!Folder::parse(output).ready());
        }
        let dir = tempfile::tempdir().unwrap();
        for i in 0..205 {
            fs::create_dir(dir.path().join(format!("folder{i}"))).unwrap();
        }
        assert_eq!(run(dir.path().to_str().unwrap(), false).children.len(), 200);
    }

    #[test]
    fn apple_and_desktop_use_the_same_host_script() {
        let swift =
            include_str!("../../../../../apple/TetherKit/Sources/TetherKit/Chat/ChatFolders.swift");
        assert!(swift.contains(SCRIPT));
    }
}
