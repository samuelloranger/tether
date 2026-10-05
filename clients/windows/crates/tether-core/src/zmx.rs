pub const ZMX: &str = "~/.local/bin/zmx";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ZmxSession {
    pub name: String,
    pub pid: i64,
    pub clients: i64,
    pub created: i64,
    pub cwd: String,
}

impl ZmxSession {
    /// The cwd as a path: zmx may report an OSC 7 style `file://host/path`.
    pub fn display_cwd(&self) -> &str {
        let Some(rest) = self.cwd.strip_prefix("file://") else {
            return &self.cwd;
        };
        match rest.find('/') {
            Some(slash) => &rest[slash..],
            None => rest,
        }
    }

    pub fn cwd_leaf(&self) -> Option<&str> {
        let path = self.display_cwd();
        if path.is_empty() {
            return None;
        }
        if path.trim_end_matches('/').is_empty() {
            return Some("/");
        }
        path.trim_end_matches('/').rsplit('/').next()
    }
}

pub fn parse_ls(output: &str) -> Vec<ZmxSession> {
    output
        .split('\n')
        .filter_map(|line| {
            let mut s = ZmxSession::default();
            let mut name = None;
            for pair in line.split('\t') {
                let Some((key, value)) = pair.trim().split_once('=') else {
                    continue;
                };
                match key {
                    "name" => name = Some(value.to_owned()),
                    "pid" => s.pid = value.parse().unwrap_or(0),
                    "clients" => s.clients = value.parse().unwrap_or(0),
                    "created" => s.created = value.parse().unwrap_or(0),
                    "cwd" => s.cwd = value.to_owned(),
                    _ => {}
                }
            }
            s.name = name.filter(|n| !n.is_empty())?;
            Some(s)
        })
        .collect()
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'"'"'"#))
}

/// The attach line is typed into a shell, so a control character (a newline above all)
/// would end or alter the command line before the quote closes.
pub fn valid_session_name(name: &str) -> bool {
    !name.trim().is_empty() && !name.chars().any(char::is_control)
}

pub fn ls_command() -> String {
    format!("{ZMX} ls")
}

pub fn attach_command(name: &str) -> String {
    format!("{ZMX} attach {}\n", shell_quote(name))
}

pub fn kill_command(name: &str) -> String {
    format!("{ZMX} kill {} --force", shell_quote(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tab_separated_pairs() {
        let out = "name=default\tpid=41\tclients=1\tcreated=1700000000\tcwd=/home/u/src\n\
                   name=build\tpid=42\tclients=0\tcreated=1700000100\tcwd=file://box/home/u/build\n";
        let s = parse_ls(out);
        assert_eq!(s.len(), 2);
        assert_eq!(
            s[0],
            ZmxSession {
                name: "default".into(),
                pid: 41,
                clients: 1,
                created: 1_700_000_000,
                cwd: "/home/u/src".into()
            }
        );
        assert_eq!(s[1].display_cwd(), "/home/u/build");
        assert_eq!(s[1].cwd_leaf(), Some("build"));
    }

    #[test]
    fn lines_without_a_name_are_skipped_and_numbers_default_to_zero() {
        let s = parse_ls("garbage line\n name=x \tpid=nope\n\nname=\tpid=3\n");
        assert_eq!(
            s,
            vec![ZmxSession {
                name: "x".into(),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn cwd_leaf_handles_root_trailing_slash_and_empty() {
        let mut s = ZmxSession {
            name: "a".into(),
            ..Default::default()
        };
        assert_eq!(s.cwd_leaf(), None);
        s.cwd = "/".into();
        assert_eq!(s.cwd_leaf(), Some("/"));
        s.cwd = "/home/u/".into();
        assert_eq!(s.cwd_leaf(), Some("u"));
        s.cwd = "file://host".into();
        assert_eq!(s.display_cwd(), "host");
    }

    #[test]
    fn commands_use_the_ios_binary_path() {
        assert_eq!(ls_command(), "~/.local/bin/zmx ls");
        assert_eq!(
            attach_command("default"),
            "~/.local/bin/zmx attach 'default'\n"
        );
        assert_eq!(
            kill_command("build"),
            "~/.local/bin/zmx kill 'build' --force"
        );
    }

    #[test]
    fn hostile_names_stay_one_argument() {
        assert_eq!(shell_quote("it's"), r#"'it'"'"'s'"#);
        assert_eq!(
            attach_command("my session"),
            "~/.local/bin/zmx attach 'my session'\n"
        );
        assert_eq!(
            kill_command("$(rm -rf ~)"),
            "~/.local/bin/zmx kill '$(rm -rf ~)' --force"
        );
        assert_eq!(shell_quote("日本"), "'日本'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn control_characters_are_not_valid_names() {
        assert!(valid_session_name("build"));
        assert!(valid_session_name("it's mine"));
        assert!(!valid_session_name(""));
        assert!(!valid_session_name("   "));
        assert!(!valid_session_name("a\nb"));
        assert!(!valid_session_name("a\rb"));
        assert!(!valid_session_name("a\u{1b}b"));
        assert!(!valid_session_name("a\u{7f}"));
    }
}
