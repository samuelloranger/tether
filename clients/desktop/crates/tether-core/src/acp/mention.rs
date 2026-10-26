//! `@file` mentions in the composer: finding the token under the cursor, ranking the host's
//! files against it and writing the pick back. Plain `@path` text is what the agent resolves
//! itself. Offsets are in characters (Unicode scalar values), not bytes.

use std::collections::HashSet;
use std::ops::Range;
use std::time::Duration;

use crate::zmx::shell_quote;

/// `range` covers the whole word, `@` included; `query` is what was typed between the `@` and
/// the cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub range: Range<usize>,
    pub query: String,
}

/// The `@word` the cursor sits in or right after. `@` only counts at the start of a word, so
/// an address like `me@host` never opens the palette. A None cursor means the end of the text.
pub fn token(text: &str, cursor: Option<usize>) -> Option<Token> {
    let chars: Vec<char> = text.chars().collect();
    let caret = cursor.unwrap_or(chars.len()).min(chars.len());
    let mut start = caret;
    while start > 0 && !chars[start - 1].is_whitespace() {
        start -= 1;
    }
    if start >= caret || chars[start] != '@' {
        return None;
    }
    let typed = &chars[start + 1..caret];
    if typed.contains(&'@') {
        return None;
    }
    let mut end = caret;
    while end < chars.len() && !chars[end].is_whitespace() {
        end += 1;
    }
    Some(Token {
        range: start..end,
        query: typed.iter().collect(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub path: String,
}

impl Match {
    pub fn new(path: &str) -> Self {
        Self {
            path: path.to_string(),
        }
    }

    pub fn name(&self) -> &str {
        self.path
            .rsplit('/')
            .find(|p| !p.is_empty())
            .unwrap_or(&self.path)
    }

    /// The folder with its trailing slash, or empty for a file at the top.
    pub fn folder(&self) -> &str {
        self.path
            .get(..self.path.len() - self.name().len())
            .unwrap_or("")
    }
}

fn is_subsequence(needle: &[char], haystack: &str) -> bool {
    let mut next = 0;
    for c in haystack.chars() {
        if next < needle.len() && c == needle[next] {
            next += 1;
        }
    }
    next == needle.len()
}

/// Case-insensitive subsequence match. A match in the file name ranks first (prefix, then
/// contains, then scattered), a match only across the path last; then shorter paths, then the
/// order the host listed them. An empty query lists the first entries as listed.
pub fn matches(query: &str, files: &[String], limit: usize) -> Vec<Match> {
    let needle_text = query.to_lowercase();
    let needle: Vec<char> = needle_text.chars().collect();
    if needle.is_empty() {
        return files.iter().take(limit).map(|f| Match::new(f)).collect();
    }
    let mut scored: Vec<(u8, usize, usize, &String)> = Vec::new();
    for (index, path) in files.iter().enumerate() {
        let lower = path.to_lowercase();
        if !is_subsequence(&needle, &lower) {
            continue;
        }
        let name = lower
            .rsplit('/')
            .find(|p| !p.is_empty())
            .unwrap_or(&lower)
            .to_string();
        let tier = if name.starts_with(&needle_text) {
            0
        } else if name.contains(&needle_text) {
            1
        } else if is_subsequence(&needle, &name) {
            2
        } else {
            3
        };
        scored.push((tier, path.chars().count(), index, path));
    }
    scored.sort_by_key(|(tier, len, index, _)| (*tier, *len, *index));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, _, p)| Match::new(p))
        .collect()
}

/// The text with the token replaced by `@path` and a space, and the cursor just after it. A
/// space already following the token is reused rather than doubled.
pub fn insertion(text: &str, token: &Token, path: &str) -> (String, usize) {
    let mut chars: Vec<char> = text.chars().collect();
    let lower = token.range.start.min(chars.len());
    let upper = token.range.end.min(chars.len());
    let followed_by_space = upper < chars.len() && chars[upper].is_whitespace();
    let replacement: Vec<char> = format!("@{path}{}", if followed_by_space { "" } else { " " })
        .chars()
        .collect();
    let cursor = lower + replacement.len() + usize::from(followed_by_space);
    chars.splice(lower..upper, replacement);
    (chars.into_iter().collect(), cursor)
}

/// How many matches the palette lists by default.
pub const DEFAULT_LIMIT: usize = 60;
pub const MAX_FILES: usize = 3000;
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// Past this the list is refetched when the palette opens.
pub const FRESH_FOR: Duration = Duration::from_secs(60);

/// A POSIX script run through `sh -c`, so the host's login shell (fish treats `( )` as a
/// command substitution) does not matter. Git's own list, else every plain file outside
/// `.git` and `node_modules`.
pub fn file_list_command(cwd: &str) -> String {
    let script = format!(
        "cd {} && (git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sed 's|^\\./||') | head -{MAX_FILES}",
        shell_quote(cwd)
    );
    format!("sh -c {}", shell_quote(&script))
}

/// Relative paths only; a name with whitespace or a control character cannot be written as
/// plain `@path`.
pub fn parse_file_list(output: &str) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut files = Vec::new();
    let cut = output
        .char_indices()
        .nth(MAX_OUTPUT_BYTES)
        .map_or(output.len(), |(i, _)| i);
    for path in output[..cut].split(|c: char| {
        matches!(
            c,
            '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}'
        )
    }) {
        if path.is_empty()
            || path.starts_with('/')
            || path.starts_with("../")
            || path.contains("/../")
            || path.chars().any(|c| c.is_whitespace() || c.is_control())
            || !seen.insert(path)
        {
            continue;
        }
        files.push(path.to_string());
        if files.len() >= MAX_FILES {
            break;
        }
    }
    files
}

/// One chat's cached file list. Times are durations since any fixed start the caller keeps.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileIndex {
    files: Vec<String>,
    loaded_at: Option<Duration>,
}

impl FileIndex {
    pub fn files(&self) -> &[String] {
        &self.files
    }

    pub fn store(&mut self, files: Vec<String>, now: Duration) {
        self.files = files;
        self.loaded_at = Some(now);
    }

    pub fn is_stale(&self, now: Duration) -> bool {
        match self.loaded_at {
            None => true,
            Some(at) => now.saturating_sub(at) > FRESH_FOR,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tk(text: &str, cursor: Option<usize>) -> Option<Token> {
        token(text, cursor)
    }

    #[test]
    fn a_word_that_starts_with_at_is_a_token_up_to_the_cursor() {
        assert_eq!(
            tk("look at @src/ma", None),
            Some(Token {
                range: 8..15,
                query: "src/ma".into()
            })
        );
        assert_eq!(
            tk("@", Some(1)),
            Some(Token {
                range: 0..1,
                query: String::new()
            })
        );
        assert_eq!(
            tk("@a b", Some(2)),
            Some(Token {
                range: 0..2,
                query: "a".into()
            })
        );
    }

    #[test]
    fn an_email_like_word_or_a_mid_word_at_never_triggers() {
        assert_eq!(tk("mail me@example.com", None), None);
        assert_eq!(tk("me@", None), None);
        assert_eq!(tk("a@b @", Some(3)), None);
        assert_eq!(tk("(@src", None), None);
        assert_eq!(tk("@a@b", None), None);
    }

    #[test]
    fn the_token_ends_where_the_cursor_leaves_it() {
        assert_eq!(tk("@src/main.swift and more", Some(17)), None);
        assert_eq!(tk("@src ", Some(5)), None);
        assert_eq!(tk("hello", Some(3)), None);
        assert_eq!(tk("@src", Some(0)), None);
        let t = tk("@src/main end", Some(4)).unwrap();
        assert_eq!(t.range, 0..9);
        assert_eq!(t.query, "src");
    }

    #[test]
    fn a_cursor_past_the_end_is_clamped_and_a_newline_ends_a_word() {
        assert_eq!(tk("x\n@ab", Some(99)).unwrap().query, "ab");
        assert_eq!(tk("@ab\n", Some(4)), None);
    }

    fn paths(found: Vec<Match>) -> Vec<String> {
        found.into_iter().map(|m| m.path).collect()
    }

    fn list(files: &[&str]) -> Vec<String> {
        files.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn matching_is_a_case_insensitive_subsequence() {
        let files = list(&["Sources/App/Main.swift", "README.md", "docs/guide.md"]);
        assert_eq!(paths(matches("rdm", &files, 60)), ["README.md"]);
        assert_eq!(
            paths(matches("MAIN", &files, 60)),
            ["Sources/App/Main.swift"]
        );
        assert!(matches("zzz", &files, 60).is_empty());
    }

    #[test]
    fn a_file_name_match_beats_a_path_match_then_shorter_then_listed_order() {
        let files = list(&[
            "config/app/settings.json",
            "src/config.swift",
            "config.yml",
            "lib/my-config.ts",
            "src/c-o-n-f-i-g.txt",
            "src/config.swiftx",
        ]);
        assert_eq!(
            paths(matches("config", &files, 60)),
            [
                "config.yml",
                "src/config.swift",
                "src/config.swiftx",
                "lib/my-config.ts",
                "src/c-o-n-f-i-g.txt",
                "config/app/settings.json"
            ]
        );
    }

    #[test]
    fn equal_matches_keep_the_listed_order() {
        let files = list(&["b/x.txt", "a/x.txt", "c/x.txt"]);
        assert_eq!(paths(matches("x", &files, 60)), files);
    }

    #[test]
    fn an_empty_query_lists_the_first_entries_as_listed_up_to_the_limit() {
        let files: Vec<String> = (0..10).map(|i| format!("f{i}.txt")).collect();
        assert_eq!(
            paths(matches("", &files, 3)),
            ["f0.txt", "f1.txt", "f2.txt"]
        );
        assert!(matches("", &files, 0).is_empty());
    }

    #[test]
    fn a_match_splits_into_a_name_and_a_folder() {
        let nested = Match::new("Sources/App/Main.swift");
        assert_eq!(nested.name(), "Main.swift");
        assert_eq!(nested.folder(), "Sources/App/");
        let top = Match::new("README.md");
        assert_eq!(top.name(), "README.md");
        assert_eq!(top.folder(), "");
    }

    #[test]
    fn picking_replaces_the_token_and_adds_a_trailing_space() {
        let text = "read @sr and fix";
        let t = token(text, Some(8)).unwrap();
        let (out, cursor) = insertion(text, &t, "src/main.swift");
        assert_eq!(out, "read @src/main.swift and fix");
        assert_eq!(cursor, "read @src/main.swift ".chars().count());
    }

    #[test]
    fn picking_at_the_end_leaves_one_trailing_space_and_the_cursor_after_it() {
        let text = "see @RE";
        let t = token(text, None).unwrap();
        let (out, cursor) = insertion(text, &t, "README.md");
        assert_eq!(out, "see @README.md ");
        assert_eq!(cursor, out.chars().count());
    }

    #[test]
    fn picking_replaces_the_rest_of_the_word_after_the_cursor() {
        let text = "@sr/old.txt tail";
        let t = token(text, Some(3)).unwrap();
        assert_eq!(insertion(text, &t, "src/new.txt").0, "@src/new.txt tail");
    }

    /// What `sh` makes of one single-quoted word, enough to read back what shell_quote wrote.
    fn unquote(quoted: &str) -> String {
        let (mut out, mut single, mut double) = (String::new(), false, false);
        for c in quoted.chars() {
            if single {
                if c == '\'' {
                    single = false;
                } else {
                    out.push(c);
                }
            } else if double {
                if c == '"' {
                    double = false;
                } else {
                    out.push(c);
                }
            } else if c == '\'' {
                single = true;
            } else if c == '"' {
                double = true;
            } else {
                out.push(c);
            }
        }
        out
    }

    #[test]
    fn the_list_command_runs_in_sh_and_a_hostile_folder_stays_one_quoted_word() {
        let hostile = "/tmp/it's; rm -rf ~ $(x) `y`";
        let command = file_list_command(hostile);
        assert!(command.starts_with("sh -c "));
        let script = unquote(&command["sh -c ".len()..]);
        assert!(script.starts_with(&format!("cd {} && (", shell_quote(hostile))));
        assert_eq!(unquote(&shell_quote(hostile)), hostile);
        assert!(
            script.contains("git ls-files -co --exclude-standard 2>/dev/null || find . -type f")
        );
        assert!(script.contains("-not -path '*/node_modules/*'"));
        assert!(script.ends_with("| head -3000"));
    }

    #[test]
    fn parsing_keeps_plain_relative_paths_and_skips_the_rest() {
        let output = "a.txt\nsrc/b.swift\nhas space.txt\ntab\tname\n/abs/path\n../up\nx/../y\n\u{1B}[31mesc\na.txt\n\nna\u{ef}ve/\u{fc}n\u{ef}.md\n";
        assert_eq!(
            parse_file_list(output),
            ["a.txt", "src/b.swift", "na\u{ef}ve/\u{fc}n\u{ef}.md"]
        );
    }

    #[test]
    fn parsing_caps_the_count() {
        let output: Vec<String> = (0..MAX_FILES + 50).map(|i| format!("f{i}")).collect();
        assert_eq!(parse_file_list(&output.join("\n")).len(), MAX_FILES);
    }

    #[test]
    fn the_cache_is_fresh_for_a_minute() {
        let mut index = FileIndex::default();
        let t0 = Duration::from_secs(1000);
        assert!(index.is_stale(t0));
        index.store(vec!["a".into()], t0);
        assert!(!index.is_stale(t0 + Duration::from_secs(59)));
        assert!(index.is_stale(t0 + Duration::from_secs(61)));
        assert_eq!(index.files(), ["a"]);
    }
}
