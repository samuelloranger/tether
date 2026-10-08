//! Reads OpenSSH client config (`~/.ssh/config`) into concrete hosts to import.

use std::path::{Path, PathBuf};

const MAX_INCLUDE_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub identity_file: Option<PathBuf>,
    /// ProxyJump hops, first hop first. Each is an alias or `[user@]host[:port]`.
    pub jumps: Vec<String>,
}

#[derive(Debug, Clone)]
struct Block {
    patterns: Vec<String>,
    /// `Match` blocks can't be evaluated without a connection; they never apply.
    is_match: bool,
    settings: Vec<(String, String)>,
}

/// Reads a file the parser asked for. `None` when it does not exist or can't be read.
pub trait ConfigFiles {
    fn read(&self, path: &Path) -> Option<String>;
    /// Entries of `dir` whose file name matches `pattern` (`*` and `?`), sorted.
    fn glob(&self, dir: &Path, pattern: &str) -> Vec<PathBuf>;
}

pub struct DiskFiles;

impl ConfigFiles for DiskFiles {
    fn read(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn glob(&self, dir: &Path, pattern: &str) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut out: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| e.path().is_file())
            .filter(|e| glob_match(pattern, &e.file_name().to_string_lossy()))
            .map(|e| e.path())
            .collect();
        out.sort();
        out
    }
}

/// `~/.ssh/config` and everything it includes, as the hosts it names explicitly.
/// Wildcard-only `Host` lines feed defaults to those hosts but are not hosts themselves.
pub fn read_config(home: &Path, files: &dyn ConfigFiles) -> Vec<ConfigHost> {
    let ssh_dir = home.join(".ssh");
    let mut blocks = Vec::new();
    load(
        &ssh_dir.join("config"),
        home,
        &ssh_dir,
        files,
        0,
        &mut blocks,
    );
    resolve(&blocks, home)
}

fn load(
    path: &Path,
    home: &Path,
    ssh_dir: &Path,
    files: &dyn ConfigFiles,
    depth: usize,
    blocks: &mut Vec<Block>,
) {
    if depth > MAX_INCLUDE_DEPTH {
        return;
    }
    let Some(text) = files.read(path) else {
        return;
    };
    // Lines before the first Host apply to every host.
    blocks.push(Block {
        patterns: vec!["*".into()],
        is_match: false,
        settings: Vec::new(),
    });
    for line in text.lines() {
        let Some((key, value)) = split_line(line) else {
            continue;
        };
        match key.as_str() {
            "host" => blocks.push(Block {
                patterns: words(&value),
                is_match: false,
                settings: Vec::new(),
            }),
            "match" => blocks.push(Block {
                patterns: Vec::new(),
                is_match: true,
                settings: Vec::new(),
            }),
            "include" => {
                let holder = blocks.last().cloned();
                for target in words(&value) {
                    let target = expand_home(&target, home);
                    let target = if target.is_absolute() {
                        target
                    } else {
                        ssh_dir.join(target)
                    };
                    for file in expand_glob(&target, files) {
                        load(&file, home, ssh_dir, files, depth + 1, blocks);
                    }
                }
                // Lines after an Include stay in the block that held it.
                if let Some(holder) = holder {
                    blocks.push(Block {
                        settings: Vec::new(),
                        ..holder
                    });
                }
            }
            _ => {
                if let Some(block) = blocks.last_mut() {
                    block.settings.push((key, value));
                }
            }
        }
    }
}

fn expand_glob(path: &Path, files: &dyn ConfigFiles) -> Vec<PathBuf> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !name.contains(['*', '?']) {
        return vec![path.to_path_buf()];
    }
    match path.parent() {
        Some(dir) => files.glob(dir, &name),
        None => Vec::new(),
    }
}

fn split_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let split = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..split].to_ascii_lowercase();
    let value = line[split..]
        .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
        .trim();
    Some((key, unquote(value)))
}

fn unquote(v: &str) -> String {
    v.strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(v)
        .to_string()
}

fn words(v: &str) -> Vec<String> {
    v.split_whitespace().map(unquote).collect()
}

fn expand_home(v: &str, home: &Path) -> PathBuf {
    match v.strip_prefix("~/").or_else(|| v.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None if v == "~" => home.to_path_buf(),
        None => PathBuf::from(v),
    }
}

pub(crate) fn glob_match(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    go(&p, &t)
}

/// OpenSSH semantics: a negated pattern that matches excludes the block outright.
fn block_applies(patterns: &[String], alias: &str) -> bool {
    let mut hit = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob_match(neg, alias) {
                return false;
            }
        } else if glob_match(p, alias) {
            hit = true;
        }
    }
    hit
}

fn resolve(blocks: &[Block], home: &Path) -> Vec<ConfigHost> {
    let mut aliases: Vec<String> = Vec::new();
    for b in blocks.iter().filter(|b| !b.is_match) {
        for p in &b.patterns {
            if !p.contains(['*', '?', '!']) && !aliases.iter().any(|a| a == p) {
                aliases.push(p.clone());
            }
        }
    }
    aliases
        .into_iter()
        .map(|alias| {
            // First value wins, in file order.
            let get = |key: &str| {
                blocks
                    .iter()
                    .filter(|b| !b.is_match && block_applies(&b.patterns, &alias))
                    .flat_map(|b| b.settings.iter())
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v.clone())
            };
            let jumps = get("proxyjump")
                .filter(|j| !j.eq_ignore_ascii_case("none"))
                .map(|j| {
                    j.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            ConfigHost {
                host: get("hostname")
                    .map(|h| h.replace("%h", &alias))
                    .unwrap_or_else(|| alias.clone()),
                port: get("port").and_then(|p| p.parse().ok()).unwrap_or(22),
                user: get("user"),
                identity_file: get("identityfile")
                    .filter(|f| !f.eq_ignore_ascii_case("none"))
                    .map(|f| expand_home(&f, home)),
                jumps,
                alias,
            }
        })
        .collect()
}

/// A ProxyJump hop that is not an alias: `[user@]host[:port]`, or `[v6]:port`.
pub fn parse_hop(hop: &str) -> (Option<String>, String, u16) {
    let (user, rest) = match hop.rsplit_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, hop),
    };
    if let Some(v6) = rest.strip_prefix('[')
        && let Some((host, tail)) = v6.split_once(']')
    {
        let port = tail
            .strip_prefix(':')
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);
        return (user, host.to_string(), port);
    }
    match rest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => {
            (user, host.to_string(), port.parse().unwrap_or(22))
        }
        _ => (user, rest.to_string(), 22),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Files(HashMap<PathBuf, String>);

    impl ConfigFiles for Files {
        fn read(&self, path: &Path) -> Option<String> {
            self.0.get(path).cloned()
        }
        fn glob(&self, dir: &Path, pattern: &str) -> Vec<PathBuf> {
            let mut out: Vec<PathBuf> = self
                .0
                .keys()
                .filter(|p| p.parent() == Some(dir))
                .filter(|p| glob_match(pattern, &p.file_name().unwrap().to_string_lossy()))
                .cloned()
                .collect();
            out.sort();
            out
        }
    }

    fn home() -> PathBuf {
        PathBuf::from("/home/u")
    }

    fn read(files: &[(&str, &str)]) -> Vec<ConfigHost> {
        let map = files
            .iter()
            .map(|(p, t)| (home().join(p), t.to_string()))
            .collect();
        read_config(&home(), &Files(map))
    }

    #[test]
    fn concrete_hosts_get_their_settings_and_wildcards_give_defaults() {
        let hosts = read(&[(
            ".ssh/config",
            "# comment\n\
             Host devbox\n  HostName 10.0.0.5\n  User sam\n  Port 2222\n  IdentityFile ~/.ssh/id_dev\n\
             Host db1 db2\n  User=ops\n\
             Host *\n  User fallback\n  IdentityFile ~/.ssh/id_default\n",
        )]);
        let names: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, ["devbox", "db1", "db2"]);
        let dev = &hosts[0];
        assert_eq!((dev.host.as_str(), dev.port), ("10.0.0.5", 2222));
        assert_eq!(dev.user.as_deref(), Some("sam"));
        assert_eq!(dev.identity_file, Some(home().join(".ssh/id_dev")));
        let db = &hosts[1];
        assert_eq!((db.host.as_str(), db.port), ("db1", 22));
        assert_eq!(db.user.as_deref(), Some("ops"), "the first value wins");
        assert_eq!(db.identity_file, Some(home().join(".ssh/id_default")));
    }

    #[test]
    fn keywords_ignore_case_and_values_can_be_quoted() {
        let hosts = read(&[(
            ".ssh/config",
            "HOST box\n\tHOSTNAME \"box.example\"\n\tuser  me\n",
        )]);
        assert_eq!(hosts[0].host, "box.example");
        assert_eq!(hosts[0].user.as_deref(), Some("me"));
    }

    #[test]
    fn negated_patterns_and_match_blocks_do_not_apply() {
        let hosts = read(&[(
            ".ssh/config",
            "Host box other\n  HostName box.lan\n\
             Host * !box\n  User nobody\n\
             Match exec \"true\"\n  User matched\n",
        )]);
        assert_eq!(hosts[0].user, None);
        assert_eq!(hosts[1].user.as_deref(), Some("nobody"));
        assert_eq!(hosts.len(), 2);
    }

    #[test]
    fn proxy_jump_lists_hops_in_order_and_none_clears_it() {
        let hosts = read(&[(
            ".ssh/config",
            "Host inner\n  ProxyJump bastion,me@edge:2200\n\
             Host direct\n  ProxyJump none\n\
             Host *\n  ProxyJump gate\n",
        )]);
        assert_eq!(hosts[0].jumps, ["bastion", "me@edge:2200"]);
        assert!(hosts[1].jumps.is_empty());
    }

    #[test]
    fn includes_are_read_relative_to_the_ssh_dir_with_globs() {
        let hosts = read(&[
            (".ssh/config", "Include conf.d/*.conf\nHost top\n"),
            (".ssh/conf.d/a.conf", "Host a\n  User ua\n"),
            (".ssh/conf.d/b.conf", "Host b\n"),
            (".ssh/conf.d/skip.txt", "Host skipped\n"),
        ]);
        let names: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, ["a", "b", "top"]);
        assert_eq!(hosts[0].user.as_deref(), Some("ua"));
    }

    #[test]
    fn lines_after_an_include_stay_in_the_including_block() {
        let hosts = read(&[
            (
                ".ssh/config",
                "Host top
  Include extra
  User after
",
            ),
            (
                ".ssh/extra",
                "Host inner
  User inside
",
            ),
        ]);
        let top = hosts.iter().find(|h| h.alias == "top").unwrap();
        assert_eq!(top.user.as_deref(), Some("after"));
        let inner = hosts.iter().find(|h| h.alias == "inner").unwrap();
        assert_eq!(inner.user.as_deref(), Some("inside"));
    }

    #[test]
    fn a_self_including_file_stops() {
        let hosts = read(&[(".ssh/config", "Include config\nHost x\n")]);
        assert_eq!(hosts[0].alias, "x");
    }

    #[test]
    fn a_missing_config_is_no_hosts() {
        assert!(read(&[]).is_empty());
    }

    #[test]
    fn hops_parse_user_host_and_port() {
        assert_eq!(parse_hop("edge"), (None, "edge".into(), 22));
        assert_eq!(
            parse_hop("me@edge:2200"),
            (Some("me".into()), "edge".into(), 2200)
        );
        assert_eq!(parse_hop("[::1]:2222"), (None, "::1".into(), 2222));
        assert_eq!(parse_hop("fe80::1"), (None, "fe80::1".into(), 22));
    }

    #[test]
    fn a_home_folder_on_disk_reads_includes_and_tilde_identity_files() {
        let home = tempfile::tempdir().unwrap();
        let ssh = home.path().join(".ssh");
        std::fs::create_dir_all(ssh.join("conf.d")).unwrap();
        std::fs::write(
            ssh.join("config"),
            "Include conf.d/*.conf\nHost *\n  User fallback\n",
        )
        .unwrap();
        std::fs::write(
            ssh.join("conf.d/work.conf"),
            "Host box\n  HostName 10.0.0.9\n  IdentityFile ~/.ssh/id_box\n",
        )
        .unwrap();
        let hosts = read_config(home.path(), &DiskFiles);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "box");
        assert_eq!(hosts[0].user.as_deref(), Some("fallback"));
        assert_eq!(hosts[0].identity_file, Some(ssh.join("id_box")));
    }
}
