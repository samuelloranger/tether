//! A tool call's content is markdown, as ACP defines text content (the shell tool sends its
//! output as a fenced block); the raw output is the fallback when the agent sent no content.

use crate::markdown::{Item, ItemKind, items};

pub const MAX_CODE_LINES: usize = 200;
/// A longer line is cut: a minified file or a data dump must not be laid out whole.
pub const MAX_LINE_CHARACTERS: usize = 2_000;
pub const MAX_CHARACTERS: usize = 100_000;
/// A run of base64 alphabet this long is an encoded blob, not text anyone reads.
pub const BLOB_RUN: usize = 1_500;

pub fn has_content(text: Option<&str>, raw_output: Option<&str>) -> bool {
    is_present(text) || is_present(raw_output)
}

pub fn blocks(text: Option<&str>, raw_output: Option<&str>) -> Vec<Item> {
    let parsed: Vec<Item> = if let Some(t) = text.filter(|t| is_present(Some(t))) {
        items(&bounded(t))
    } else if let Some(r) = raw_output.filter(|r| is_present(Some(r))) {
        vec![Item {
            kind: ItemKind::Code,
            level: 0,
            text: bounded(r),
            links: Vec::new(),
        }]
    } else {
        Vec::new()
    };
    parsed.into_iter().map(capped).collect()
}

/// True for an image result dumped as JSON text, or any text carrying a long base64 run.
pub fn looks_like_blob(text: &str) -> bool {
    let bytes = text.as_bytes();
    if let Some(&first) = bytes.first()
        && (first == b'[' || first == b'{')
        && (text.contains("\"type\":\"image\"") || text.contains("\"type\": \"image\""))
    {
        return true;
    }
    let mut run = 0;
    for &b in bytes {
        if b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=' {
            run += 1;
            if run >= BLOB_RUN {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

fn is_present(text: Option<&str>) -> bool {
    match text {
        Some(t) if !looks_like_blob(t) => !t.trim().is_empty(),
        _ => false,
    }
}

fn bounded(text: &str) -> String {
    match text.char_indices().nth(MAX_CHARACTERS) {
        Some((cut, _)) => format!("{}\n\u{2026}", &text[..cut]),
        None => text.to_string(),
    }
}

fn cut_line(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE_CHARACTERS) {
        Some((cut, _)) => format!("{}\u{2026}", &line[..cut]),
        None => line.to_string(),
    }
}

fn capped(mut item: Item) -> Item {
    if item.kind != ItemKind::Code {
        return item;
    }
    let lines: Vec<String> = item.text.split('\n').map(cut_line).collect();
    item.text = if lines.len() > MAX_CODE_LINES {
        let mut shown: Vec<String> = lines[..MAX_CODE_LINES].to_vec();
        shown.push(format!(
            "\u{2026} {} more lines",
            lines.len() - MAX_CODE_LINES
        ));
        shown.join("\n")
    } else {
        lines.join("\n")
    };
    item
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(text: &str) -> Item {
        Item {
            kind: ItemKind::Code,
            level: 0,
            text: text.to_string(),
            links: Vec::new(),
        }
    }

    #[test]
    fn wide_tables_keep_their_columns_and_links_without_code_truncation() {
        let finding = "A long finding. ".repeat(150);
        let table = format!(
            "| Severity | Finding | Action |\n|---|---|---|\n| High | {finding} | [Back up](https://example.test/backup) |"
        );
        let parsed = blocks(Some(&table), None);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].kind, ItemKind::Table);
        assert_eq!(parsed[0].text.lines().count(), 3);
        assert!(parsed[0].text.contains(finding.trim_end()));
        assert!(parsed[0].text.lines().last().unwrap().ends_with("Back up"));
        assert_eq!(parsed[0].links[0].url, "https://example.test/backup");
    }

    #[test]
    fn shell_output_arrives_as_a_code_block_not_literal_backticks() {
        let b = blocks(Some("```console\nports 8081 closed\n```"), Some("ignored"));
        assert_eq!(b, [code("ports 8081 closed")]);
    }

    #[test]
    fn prose_and_a_fence_in_one_result_both_render() {
        let b = blocks(Some("Ran it:\n\n```console\nok\n```"), None);
        assert_eq!(b.len(), 2);
        assert_eq!(b.last().unwrap(), &code("ok"));
    }

    #[test]
    fn raw_output_is_the_fallback_when_there_is_no_content() {
        assert_eq!(blocks(None, Some("a\nb")), [code("a\nb")]);
        assert_eq!(blocks(Some("  \n"), Some("a")), [code("a")]);
    }

    #[test]
    fn nothing_to_show_is_empty() {
        assert!(!has_content(Some(" "), None));
        assert!(blocks(None, Some("")).is_empty());
    }

    #[test]
    fn a_long_code_block_is_cut_with_a_count() {
        let lines: Vec<String> = (1..=250).map(|i| format!("line {i}")).collect();
        let b = blocks(None, Some(&lines.join("\n")));
        let shown: Vec<&str> = b[0].text.split('\n').collect();
        assert_eq!(shown.len(), MAX_CODE_LINES + 1);
        assert_eq!(*shown.last().unwrap(), "\u{2026} 50 more lines");
    }

    #[test]
    fn a_long_line_is_cut_with_an_ellipsis() {
        let line = "x ".repeat(5_000);
        let b = blocks(None, Some(&line));
        assert_eq!(b[0].text.chars().count(), MAX_LINE_CHARACTERS + 1);
        assert!(b[0].text.ends_with('\u{2026}'));
    }

    #[test]
    fn image_json_text_is_suppressed_everywhere() {
        let dump = format!(
            "[{{\"source\":{{\"data\":\"{}\"}},\"type\":\"image\"}}]",
            "iVBORw0KGgo".repeat(400)
        );
        assert!(!has_content(None, Some(&dump)));
        assert!(!has_content(Some(&dump), None));
        assert!(blocks(None, Some(&dump)).is_empty());
        assert!(blocks(Some(&dump), Some(&dump)).is_empty());
    }

    #[test]
    fn huge_text_is_bounded_before_parsing() {
        let huge: Vec<String> = (0..50_000).map(|i| format!("line {i}")).collect();
        let b = blocks(None, Some(&huge.join("\n")));
        assert_eq!(b[0].text.split('\n').count(), MAX_CODE_LINES + 1);
    }

    #[test]
    fn blobs_are_long_base64_runs_only() {
        assert!(looks_like_blob(&"A".repeat(BLOB_RUN)));
        assert!(!looks_like_blob(&format!(
            "plain text with spaces {}",
            "word ".repeat(2000)
        )));
    }
}
