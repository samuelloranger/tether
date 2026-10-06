//! Just enough markdown for a read-only viewer: the block structure, with inline emphasis
//! flattened to plain text and links kept as separate entries (iOS `MarkdownDocument`).

use crate::links::is_openable;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkdownBlock {
    Heading { level: u8, text: String },
    Paragraph(String),
    Bullets(Vec<String>),
    Numbered(Vec<String>),
    Code(Vec<String>),
    Quote(String),
    Rule,
}

pub fn parse(body: &str) -> Vec<MarkdownBlock> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut bullets: Vec<String> = Vec::new();
    let mut numbered: Vec<String> = Vec::new();
    let mut table: Vec<String> = Vec::new();
    let mut fence: Option<Vec<String>> = None;

    fn flush_paragraph(blocks: &mut Vec<MarkdownBlock>, paragraph: &mut Vec<String>) {
        if !paragraph.is_empty() {
            blocks.push(MarkdownBlock::Paragraph(paragraph.join(" ")));
            paragraph.clear();
        }
    }
    fn flush_lists(
        blocks: &mut Vec<MarkdownBlock>,
        bullets: &mut Vec<String>,
        numbered: &mut Vec<String>,
        table: &mut Vec<String>,
    ) {
        if !bullets.is_empty() {
            blocks.push(MarkdownBlock::Bullets(std::mem::take(bullets)));
        }
        if !numbered.is_empty() {
            blocks.push(MarkdownBlock::Numbered(std::mem::take(numbered)));
        }
        if !table.is_empty() {
            blocks.push(MarkdownBlock::Code(std::mem::take(table)));
        }
    }

    for raw in body.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = raw.trim();

        if line.starts_with("```") || line.starts_with("~~~") {
            if let Some(open) = fence.take() {
                blocks.push(MarkdownBlock::Code(open));
            } else {
                flush_paragraph(&mut blocks, &mut paragraph);
                flush_lists(&mut blocks, &mut bullets, &mut numbered, &mut table);
                fence = Some(Vec::new());
            }
            continue;
        }
        if let Some(open) = fence.as_mut() {
            open.push(raw.to_owned());
            continue;
        }

        if line.is_empty() {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_lists(&mut blocks, &mut bullets, &mut numbered, &mut table);
            continue;
        }
        if matches!(line, "---" | "***" | "___") {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_lists(&mut blocks, &mut bullets, &mut numbered, &mut table);
            blocks.push(MarkdownBlock::Rule);
            continue;
        }
        if line.starts_with('#') {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_lists(&mut blocks, &mut bullets, &mut numbered, &mut table);
            let level = line.chars().take_while(|c| *c == '#').count();
            blocks.push(MarkdownBlock::Heading {
                level: level.min(3) as u8,
                text: line[level..].trim().to_owned(),
            });
            continue;
        }
        if line == ">" || line.starts_with("> ") {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_lists(&mut blocks, &mut bullets, &mut numbered, &mut table);
            blocks.push(MarkdownBlock::Quote(line[1..].trim().to_owned()));
            continue;
        }
        if line.starts_with('|') {
            flush_paragraph(&mut blocks, &mut paragraph);
            table.push(raw.to_owned());
            continue;
        }
        if let Some(item) = ["- ", "* ", "+ "].iter().find_map(|m| line.strip_prefix(m)) {
            flush_paragraph(&mut blocks, &mut paragraph);
            bullets.push(item.to_owned());
            continue;
        }
        if let Some(item) = numbered_item(line) {
            flush_paragraph(&mut blocks, &mut paragraph);
            numbered.push(item.to_owned());
            continue;
        }

        flush_lists(&mut blocks, &mut bullets, &mut numbered, &mut table);
        paragraph.push(line.to_owned());
    }

    if let Some(open) = fence.filter(|f| !f.is_empty()) {
        blocks.push(MarkdownBlock::Code(open));
    }
    flush_paragraph(&mut blocks, &mut paragraph);
    flush_lists(&mut blocks, &mut bullets, &mut numbered, &mut table);
    blocks
}

/// `3. text`: digits, a dot, then a space, so "3.14 is pi" stays a paragraph.
fn numbered_item(line: &str) -> Option<&str> {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = line[digits..].strip_prefix('.')?;
    if rest.is_empty() {
        return Some("");
    }
    rest.strip_prefix(' ').map(str::trim)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Heading,
    Paragraph,
    Bullet,
    Numbered,
    Code,
    Quote,
    Rule,
}

/// One row of the rendered document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub kind: ItemKind,
    pub level: u8,
    pub text: String,
    pub links: Vec<Link>,
}

pub fn items(blocks: &[MarkdownBlock]) -> Vec<Item> {
    fn text_item(out: &mut Vec<Item>, kind: ItemKind, level: u8, source: &str, prefix: String) {
        let (plain, links) = inline(source);
        out.push(Item {
            kind,
            level,
            text: format!("{prefix}{plain}"),
            links,
        });
    }
    let mut out = Vec::new();
    for block in blocks {
        match block {
            MarkdownBlock::Heading { level, text: t } => {
                text_item(&mut out, ItemKind::Heading, *level, t, String::new());
            }
            MarkdownBlock::Paragraph(t) => {
                text_item(&mut out, ItemKind::Paragraph, 0, t, String::new());
            }
            MarkdownBlock::Quote(t) => {
                text_item(&mut out, ItemKind::Quote, 0, t, String::new());
            }
            MarkdownBlock::Bullets(list) => {
                for t in list {
                    text_item(&mut out, ItemKind::Bullet, 0, t, "\u{2022}  ".into());
                }
            }
            MarkdownBlock::Numbered(list) => {
                for (n, t) in list.iter().enumerate() {
                    text_item(&mut out, ItemKind::Numbered, 0, t, format!("{}.  ", n + 1));
                }
            }
            MarkdownBlock::Code(lines) => out.push(Item {
                kind: ItemKind::Code,
                level: 0,
                text: lines.join("\n"),
                links: Vec::new(),
            }),
            MarkdownBlock::Rule => out.push(Item {
                kind: ItemKind::Rule,
                level: 0,
                text: String::new(),
                links: Vec::new(),
            }),
        }
    }
    out
}

/// Flattens emphasis and code spans, and lifts `[label](url)` and bare URLs into `links`.
/// Only links the app would open anywhere else are kept.
pub fn inline(source: &str) -> (String, Vec<Link>) {
    let chars: Vec<char> = source.chars().collect();
    let mut text = String::new();
    let mut links: Vec<Link> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() && chars[i + 1].is_ascii_punctuation() => {
                text.push(chars[i + 1]);
                i += 2;
            }
            '*' | '`' => i += 1,
            '!' if chars.get(i + 1) == Some(&'[') => i += 1,
            '[' => {
                if let Some((label, url, next)) = link_at(&chars, i) {
                    let (label, _) = inline(&label);
                    text.push_str(&label);
                    push_link(&mut links, label, url);
                    i = next;
                } else {
                    text.push(c);
                    i += 1;
                }
            }
            _ => {
                let rest: String = if matches!(c, 'h' | 'H') {
                    chars[i..].iter().collect()
                } else {
                    String::new()
                };
                let lower = rest.to_ascii_lowercase();
                if (lower.starts_with("http://") || lower.starts_with("https://"))
                    && (i == 0 || !chars[i - 1].is_alphanumeric())
                {
                    let end = rest
                        .find(|ch: char| ch.is_whitespace() || ch == '<' || ch == '>')
                        .unwrap_or(rest.len());
                    let url = rest[..end].trim_end_matches(['.', ',', ';', ':', ')', '!', '?']);
                    text.push_str(url);
                    push_link(&mut links, url.to_owned(), url.to_owned());
                    i += url.chars().count();
                } else {
                    text.push(c);
                    i += 1;
                }
            }
        }
    }
    (text, links)
}

fn push_link(links: &mut Vec<Link>, label: String, url: String) {
    if is_openable(&url) && !links.iter().any(|l| l.url == url) {
        links.push(Link { label, url });
    }
}

/// `[label](url)` at `start`; the closing bracket is matched with nesting, the url ends at the
/// first `)` outside balanced parentheses. Returns where scanning resumes.
fn link_at(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    let mut depth = 0;
    let mut close = None;
    for (offset, ch) in chars[start..].iter().enumerate() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(start + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let mut depth = 0;
    let mut end = None;
    for (offset, ch) in chars[close + 1..].iter().enumerate() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(close + 1 + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end?;
    let label: String = chars[start + 1..close].iter().collect();
    let target: String = chars[close + 2..end].iter().collect();
    let url = target.split_whitespace().next().unwrap_or("").to_owned();
    Some((label, url, end + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use MarkdownBlock::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn headings_carry_their_level() {
        assert_eq!(
            parse("# One\n## Two\n### Three"),
            [
                Heading {
                    level: 1,
                    text: "One".into()
                },
                Heading {
                    level: 2,
                    text: "Two".into()
                },
                Heading {
                    level: 3,
                    text: "Three".into()
                },
            ]
        );
    }

    #[test]
    fn blank_lines_separate_paragraphs_and_soft_breaks_do_not() {
        assert_eq!(
            parse("first line\nstill first\n\nsecond"),
            [
                Paragraph("first line still first".into()),
                Paragraph("second".into())
            ]
        );
    }

    #[test]
    fn bullets_group_into_one_list() {
        assert_eq!(
            parse("- one\n- two\n* three"),
            [Bullets(s(&["one", "two", "three"]))]
        );
    }

    #[test]
    fn numbered_items_keep_their_order_and_need_a_space_after_the_dot() {
        assert_eq!(
            parse("1. first\n2. second"),
            [Numbered(s(&["first", "second"]))]
        );
        assert_eq!(parse("3.14 is pi"), [Paragraph("3.14 is pi".into())]);
    }

    #[test]
    fn a_fenced_block_keeps_its_lines_verbatim() {
        assert_eq!(
            parse("before\n\n```swift\nlet a = 1\n\n  indented\n```\n\nafter"),
            [
                Paragraph("before".into()),
                Code(s(&["let a = 1", "", "  indented"])),
                Paragraph("after".into()),
            ]
        );
    }

    #[test]
    fn an_unclosed_fence_still_yields_its_lines() {
        assert_eq!(parse("```\nstranded"), [Code(s(&["stranded"]))]);
    }

    #[test]
    fn quotes_and_rules_are_their_own_blocks() {
        assert_eq!(parse("> quoted\n\n---"), [Quote("quoted".into()), Rule]);
    }

    #[test]
    fn an_empty_body_has_no_blocks() {
        assert!(parse("   \n\n").is_empty());
    }

    #[test]
    fn windows_line_endings_do_not_leak_into_the_text() {
        assert_eq!(
            parse("# Title\r\n\r\ntext\r\n"),
            [
                Heading {
                    level: 1,
                    text: "Title".into()
                },
                Paragraph("text".into())
            ]
        );
    }

    #[test]
    fn table_rows_are_kept_as_a_monospace_block() {
        assert_eq!(
            parse("| a | b |\n|---|---|\n| 1 | 2 |\n\nafter"),
            [
                Code(s(&["| a | b |", "|---|---|", "| 1 | 2 |"])),
                Paragraph("after".into())
            ]
        );
    }

    #[test]
    fn emphasis_and_code_markers_are_dropped() {
        let (text, links) = inline("a **bold** and `code` and *it*");
        assert_eq!(text, "a bold and code and it");
        assert!(links.is_empty());
    }

    #[test]
    fn a_link_keeps_its_label_in_the_text_and_its_url_aside() {
        let (text, links) = inline("see [the docs](https://example.test/a_(b)) now");
        assert_eq!(text, "see the docs now");
        assert_eq!(
            links,
            [Link {
                label: "the docs".into(),
                url: "https://example.test/a_(b)".into()
            }]
        );
    }

    #[test]
    fn bare_urls_become_links_and_lose_trailing_punctuation() {
        let (text, links) = inline("go to https://example.test/x, then");
        assert_eq!(text, "go to https://example.test/x, then");
        assert_eq!(links[0].url, "https://example.test/x");
    }

    #[test]
    fn only_links_the_app_would_open_elsewhere_are_kept() {
        let (text, links) = inline(
            "[run](javascript:alert(1)) and [file](file:///etc/passwd) and [rel](docs/a.md)",
        );
        assert_eq!(text, "run and file and rel");
        assert!(links.is_empty());
    }

    #[test]
    fn an_image_shows_its_alt_text() {
        let (text, _) = inline("![logo](https://example.test/l.png)");
        assert_eq!(text, "logo");
    }

    #[test]
    fn items_prefix_lists_and_flatten_code() {
        let list = items(&parse(
            "- a\n- b\n\n1. x\n2. [y](https://e.test/)\n\n```\nl1\nl2\n```",
        ));
        let texts: Vec<_> = list.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(
            texts,
            ["\u{2022}  a", "\u{2022}  b", "1.  x", "2.  y", "l1\nl2"]
        );
        assert_eq!(list[3].links.len(), 1);
        assert_eq!(list[4].kind, ItemKind::Code);
    }
}
