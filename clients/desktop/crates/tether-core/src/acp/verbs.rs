//! The word a running turn shows, as Claude Code's spinner picks one: its own list, read from
//! the Claude Code installed on the host, with the user's `spinnerVerbs` setting applied. The
//! list never travels over ACP, so the host is asked once; without it Tether's own words stand in.

use serde_json::Value;

use crate::zmx::shell_quote;

/// Shown when the host's Claude Code cannot be read.
pub const FALLBACK: &[&str] = &[
    "Thinking",
    "Pondering",
    "Tinkering",
    "Puzzling",
    "Mulling",
    "Sketching",
    "Untangling",
    "Wrangling",
    "Brewing",
    "Noodling",
    "Assembling",
    "Weaving",
    "Polishing",
    "Sifting",
    "Juggling",
];

const SETTINGS_MARK: &str = "--- settings";

/// One exec: the list from the installed `claude`, then the user's settings file.
pub fn command() -> String {
    let script = concat!(
        "PATH=\"$HOME/.local/bin:$PATH\"; ",
        "c=$(command -v claude) && LC_ALL=C grep -aoE '\\[\"Accomplishing\"(,\"[^\"]{1,40}\")+\\]' ",
        "\"$(readlink -f \"$c\")\" 2>/dev/null | head -n 1; ",
        "echo '--- settings'; cat \"$HOME/.claude/settings.json\" 2>/dev/null"
    );
    format!("sh -c {}", shell_quote(script))
}

/// The words to pick from: the official list (or `FALLBACK`) with `spinnerVerbs` applied the way
/// Claude Code applies it (`replace` with an empty list keeps the default).
pub fn parse(output: &str) -> Vec<String> {
    let (list, settings) = output.split_once(SETTINGS_MARK).unwrap_or((output, ""));
    let mut base: Vec<String> = list
        .lines()
        .find(|l| l.trim_start().starts_with("[\""))
        .map(js_strings)
        .unwrap_or_default();
    if base.is_empty() {
        base = FALLBACK.iter().map(|v| v.to_string()).collect();
    }
    let custom = serde_json::from_str::<Value>(settings.trim())
        .ok()
        .and_then(|v| v.get("spinnerVerbs").cloned());
    let Some(custom) = custom else {
        return base;
    };
    let verbs: Vec<String> = custom
        .get("verbs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    match custom.get("mode").and_then(Value::as_str) {
        Some("replace") if !verbs.is_empty() => verbs,
        _ => base.into_iter().chain(verbs).collect(),
    }
}

/// The turn's word, the same for the whole turn: `seed` is anything that changes per turn.
pub fn pick(verbs: &[String], seed: i64) -> String {
    let word = if verbs.is_empty() {
        FALLBACK[seed.unsigned_abs() as usize % FALLBACK.len()].to_string()
    } else {
        let mixed = (seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32;
        verbs[mixed as usize % verbs.len()].clone()
    };
    format!("{word}\u{2026}")
}

/// The string literals of a minified JS array, unescaped (`\xE9`, `\u2019`, `\'`).
fn js_strings(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut word = String::new();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => match chars.next() {
                    Some('x') => word.extend(hex(&mut chars, 2)),
                    Some('u') => word.extend(hex(&mut chars, 4)),
                    Some('n') => word.push('\n'),
                    Some(other) => word.push(other),
                    None => {}
                },
                c => word.push(c),
            }
        }
        if !word.trim().is_empty() {
            out.push(word);
        }
    }
    out
}

fn hex(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, n: usize) -> Option<char> {
    let digits: String = (0..n).filter_map(|_| chars.next()).collect();
    u32::from_str_radix(&digits, 16)
        .ok()
        .and_then(char::from_u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"["Accomplishing","Flamb\xE9ing","Beboppin'","Zigzagging"]"#;

    #[test]
    fn the_official_list_is_read_and_unescaped() {
        let verbs = parse(&format!("{LIST}\n--- settings\n"));
        assert_eq!(
            verbs,
            ["Accomplishing", "Flambéing", "Beboppin'", "Zigzagging"]
        );
    }

    #[test]
    fn spinner_verbs_append_or_replace_like_claude_code() {
        let append = parse(&format!(
            "{LIST}\n--- settings\n{{\"spinnerVerbs\":{{\"mode\":\"append\",\"verbs\":[\"Shipping\"]}}}}"
        ));
        assert_eq!(append.len(), 5);
        assert_eq!(append.last().unwrap(), "Shipping");
        let replace = parse(&format!(
            "{LIST}\n--- settings\n{{\"spinnerVerbs\":{{\"mode\":\"replace\",\"verbs\":[\"Shipping\",\"Testing\"]}}}}"
        ));
        assert_eq!(replace, ["Shipping", "Testing"]);
        let empty = parse(&format!(
            "{LIST}\n--- settings\n{{\"spinnerVerbs\":{{\"mode\":\"replace\",\"verbs\":[]}}}}"
        ));
        assert_eq!(empty.len(), 4, "an empty replace keeps the default");
    }

    #[test]
    fn without_claude_on_the_host_tethers_words_stand_in() {
        assert_eq!(parse("--- settings\n").len(), FALLBACK.len());
        assert_eq!(parse("").len(), FALLBACK.len());
        let mine =
            parse("--- settings\n{\"spinnerVerbs\":{\"mode\":\"replace\",\"verbs\":[\"Mine\"]}}");
        assert_eq!(mine, ["Mine"]);
    }

    #[test]
    fn a_turn_keeps_its_word_and_turns_vary() {
        let verbs: Vec<String> = (0..50).map(|i| format!("V{i}")).collect();
        assert_eq!(pick(&verbs, 7), pick(&verbs, 7));
        let words: std::collections::HashSet<String> = (0..20).map(|s| pick(&verbs, s)).collect();
        assert!(words.len() > 5, "{words:?}");
        assert!(pick(&verbs, 3).ends_with('\u{2026}'));
        assert!(pick(&[], -4).ends_with('\u{2026}'));
    }

    #[test]
    fn the_command_reads_the_installed_claude_and_the_settings() {
        let c = command();
        assert!(c.starts_with("sh -c '"));
        assert!(c.contains("command -v claude"));
        assert!(c.contains(".claude/settings.json"));
    }
}
