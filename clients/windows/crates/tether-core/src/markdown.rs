//! A read-only markdown viewer's rows: GitHub-flavored markdown (tables, task lists, nested
//! lists) parsed by pulldown-cmark, inline emphasis flattened to plain text, and links kept as
//! separate entries.

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::links::is_openable;

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

/// One row of the rendered document. `level` is the heading level (1–3) for a heading and
/// the nesting depth (0 at the top) for a list item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub kind: ItemKind,
    pub level: u8,
    pub text: String,
    pub links: Vec<Link>,
}

const BULLET: &str = "\u{2022}  ";
const TASK_OPEN: &str = "\u{2610}  ";
const TASK_DONE: &str = "\u{2611}  ";

pub fn items(body: &str) -> Vec<Item> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    let mut b = Builder::default();
    for event in Parser::new_ext(body, options) {
        b.event(event);
    }
    b.flush();
    b.out
}

struct List {
    next: Option<u64>,
}

struct ListItem {
    ordered: bool,
    prefix: String,
    /// A later paragraph of the same item is not numbered again.
    started: bool,
}

#[derive(Default)]
struct Table {
    rows: Vec<Vec<String>>,
    header_rows: usize,
}

#[derive(Default)]
struct Builder {
    out: Vec<Item>,
    text: String,
    /// Each explicit link with the text offset where its label starts.
    links: Vec<(usize, Link)>,
    open_links: Vec<(usize, String)>,
    heading: Option<u8>,
    quote: usize,
    lists: Vec<List>,
    items: Vec<ListItem>,
    code: Option<String>,
    table: Option<Table>,
    table_links: Vec<Link>,
    in_head: bool,
    metadata: bool,
}

impl Builder {
    fn event(&mut self, event: Event) {
        if self.metadata {
            if matches!(event, Event::End(TagEnd::MetadataBlock(_))) {
                self.metadata = false;
            }
            return;
        }
        if let Some(code) = self.code.as_mut() {
            match event {
                Event::Text(t) => code.push_str(&t),
                Event::End(TagEnd::CodeBlock) => {
                    let code = self.code.take().unwrap_or_default();
                    self.out.push(Item {
                        kind: ItemKind::Code,
                        level: 0,
                        text: code.trim_end_matches('\n').to_owned(),
                        links: Vec::new(),
                    });
                }
                _ => {}
            }
            return;
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) | Event::Code(t) | Event::InlineMath(t) | Event::DisplayMath(t) => {
                self.text.push_str(&t)
            }
            Event::SoftBreak => self.text.push(' '),
            Event::HardBreak => self.text.push('\n'),
            Event::Rule => {
                self.flush();
                self.out.push(Item {
                    kind: ItemKind::Rule,
                    level: 0,
                    text: String::new(),
                    links: Vec::new(),
                });
            }
            Event::TaskListMarker(done) => {
                if let Some(item) = self.items.last_mut() {
                    item.prefix = (if done { TASK_DONE } else { TASK_OPEN }).to_owned();
                }
            }
            Event::FootnoteReference(label) => {
                self.text.push_str(&format!("[{label}]"));
            }
            Event::Html(_) | Event::InlineHtml(_) => {}
        }
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Heading { level, .. } => {
                self.flush();
                self.heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    _ => 3,
                });
            }
            Tag::BlockQuote(_) => {
                self.flush();
                self.quote += 1;
            }
            Tag::CodeBlock(_) => {
                self.flush();
                self.code = Some(String::new());
            }
            Tag::List(start) => {
                self.flush();
                self.lists.push(List { next: start });
            }
            Tag::Item => {
                self.flush();
                let list = self.lists.last_mut();
                let (ordered, prefix) = match list.and_then(|l| l.next.as_mut()) {
                    Some(n) => {
                        let prefix = format!("{n}.  ");
                        *n += 1;
                        (true, prefix)
                    }
                    None => (false, BULLET.to_owned()),
                };
                self.items.push(ListItem {
                    ordered,
                    prefix,
                    started: false,
                });
            }
            Tag::Table(_) => {
                self.flush();
                self.table = Some(Table::default());
            }
            Tag::TableHead => self.in_head = true,
            Tag::TableRow => {
                if let Some(t) = self.table.as_mut() {
                    t.rows.push(Vec::new());
                }
            }
            Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => {
                self.open_links
                    .push((self.text.len(), dest_url.to_string()));
            }
            Tag::MetadataBlock(_) => self.metadata = true,
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::Item
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
            | TagEnd::FootnoteDefinition => self.flush(),
            TagEnd::BlockQuote(_) => {
                self.flush();
                self.quote = self.quote.saturating_sub(1);
            }
            TagEnd::List(_) => {
                self.lists.pop();
            }
            TagEnd::TableHead => {
                // The header cells arrive without a row of their own.
                if let Some(t) = self.table.as_mut() {
                    t.header_rows = t.rows.len();
                }
                self.in_head = false;
            }
            TagEnd::TableCell => {
                let (text, links) = self.take_text();
                for link in links {
                    if !self.table_links.iter().any(|l| l.url == link.url) {
                        self.table_links.push(link);
                    }
                }
                if let Some(t) = self.table.as_mut() {
                    if t.rows.is_empty() || (self.in_head && t.rows.len() == t.header_rows) {
                        t.rows.push(Vec::new());
                    }
                    if let Some(row) = t.rows.last_mut() {
                        row.push(text);
                    }
                }
            }
            TagEnd::Table => {
                let table = self.table.take().unwrap_or_default();
                let links = std::mem::take(&mut self.table_links);
                self.out.push(Item {
                    kind: ItemKind::Code,
                    level: 0,
                    text: render_table(&table),
                    links,
                });
            }
            TagEnd::Link | TagEnd::Image => {
                if let Some((start, url)) = self.open_links.pop() {
                    let label = self.text[start..].trim().to_owned();
                    self.links.push((start, Link { label, url }));
                }
            }
            _ => {}
        }
        if matches!(tag, TagEnd::Item) {
            self.items.pop();
        }
    }

    /// The pending inline text and its openable links (explicit and bare), in reading order.
    fn take_text(&mut self) -> (String, Vec<Link>) {
        let text = std::mem::take(&mut self.text);
        let mut found = std::mem::take(&mut self.links);
        found.extend(bare_urls(&text));
        found.sort_by_key(|(at, _)| *at);
        let mut links: Vec<Link> = Vec::new();
        for (_, link) in found {
            if is_openable(&link.url) && !links.iter().any(|l| l.url == link.url) {
                links.push(link);
            }
        }
        (text.trim().to_owned(), links)
    }

    fn flush(&mut self) {
        if self.text.trim().is_empty() {
            self.text.clear();
            self.links.clear();
            return;
        }
        let (text, links) = self.take_text();
        let depth = self.items.len().saturating_sub(1).min(u8::MAX as usize) as u8;
        let item = if let Some(level) = self.heading.take() {
            Item {
                kind: ItemKind::Heading,
                level,
                text,
                links,
            }
        } else if let Some(li) = self.items.last_mut() {
            let prefix = if li.started { "" } else { li.prefix.as_str() };
            let item = Item {
                kind: if self.quote > 0 {
                    ItemKind::Quote
                } else if li.ordered {
                    ItemKind::Numbered
                } else {
                    ItemKind::Bullet
                },
                level: depth,
                text: format!("{prefix}{text}"),
                links,
            };
            li.started = true;
            item
        } else if self.quote > 0 {
            Item {
                kind: ItemKind::Quote,
                level: 0,
                text,
                links,
            }
        } else {
            Item {
                kind: ItemKind::Paragraph,
                level: 0,
                text,
                links,
            }
        };
        self.out.push(item);
    }
}

/// Monospace columns padded to their widest cell, the header underlined.
fn render_table(table: &Table) -> String {
    let columns = table.rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut widths = vec![0; columns];
    for row in &table.rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    let mut lines = Vec::new();
    for (r, row) in table.rows.iter().enumerate() {
        let cells: Vec<String> = (0..columns)
            .map(|i| {
                let cell = row.get(i).map_or("", String::as_str);
                format!("{cell:<w$}", w = widths[i])
            })
            .collect();
        lines.push(cells.join("  ").trim_end().to_owned());
        if r + 1 == table.header_rows {
            let rule: Vec<String> = widths.iter().map(|w| "\u{2500}".repeat(*w)).collect();
            lines.push(rule.join("  "));
        }
    }
    lines.join("\n")
}

/// `http(s)://` URLs written as plain text, minus trailing sentence punctuation.
fn bare_urls(text: &str) -> Vec<(usize, Link)> {
    let lower = text.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = ["http://", "https://"]
        .iter()
        .filter_map(|scheme| lower[from..].find(scheme).map(|i| from + i))
        .min()
    {
        let rest = &text[found..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '<' || c == '>')
            .unwrap_or(rest.len());
        let boundary = text[..found]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let url = rest[..end].trim_end_matches(['.', ',', ';', ':', ')', '!', '?']);
        if boundary && url.len() > "https://".len() {
            out.push((
                found,
                Link {
                    label: url.to_owned(),
                    url: url.to_owned(),
                },
            ));
        }
        from = found + end.max(1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(body: &str) -> Vec<String> {
        items(body).into_iter().map(|i| i.text).collect()
    }

    fn kinds(body: &str) -> Vec<ItemKind> {
        items(body).into_iter().map(|i| i.kind).collect()
    }

    #[test]
    fn headings_carry_their_level_capped_at_three() {
        let list = items("# One\n## Two\n#### Four");
        let levels: Vec<_> = list
            .iter()
            .map(|i| (i.kind, i.level, i.text.as_str()))
            .collect();
        assert_eq!(
            levels,
            [
                (ItemKind::Heading, 1, "One"),
                (ItemKind::Heading, 2, "Two"),
                (ItemKind::Heading, 3, "Four"),
            ]
        );
    }

    #[test]
    fn blank_lines_separate_paragraphs_and_soft_breaks_do_not() {
        assert_eq!(
            texts("first line\nstill first\n\nsecond"),
            ["first line still first", "second"]
        );
    }

    #[test]
    fn bullets_and_numbers_get_their_marker() {
        assert_eq!(
            texts("- one\n- two\n\n1. first\n2. second"),
            ["\u{2022}  one", "\u{2022}  two", "1.  first", "2.  second"]
        );
        assert_eq!(kinds("- a\n\n1. b"), [ItemKind::Bullet, ItemKind::Numbered]);
    }

    #[test]
    fn a_numbered_list_keeps_its_start() {
        assert_eq!(texts("3. three\n4. four"), ["3.  three", "4.  four"]);
        assert_eq!(texts("3.14 is pi"), ["3.14 is pi"]);
    }

    #[test]
    fn nested_lists_carry_their_depth() {
        let list = items("- top\n  - inner\n    - deepest\n- next");
        let rows: Vec<_> = list.iter().map(|i| (i.level, i.text.as_str())).collect();
        assert_eq!(
            rows,
            [
                (0, "\u{2022}  top"),
                (1, "\u{2022}  inner"),
                (2, "\u{2022}  deepest"),
                (0, "\u{2022}  next"),
            ]
        );
    }

    #[test]
    fn task_list_items_show_their_state() {
        assert_eq!(
            texts("- [ ] write tests\n- [x] ship it"),
            ["\u{2610}  write tests", "\u{2611}  ship it"]
        );
    }

    #[test]
    fn a_second_paragraph_of_an_item_is_not_marked_again() {
        assert_eq!(
            texts("1. first\n\n   more about first\n2. second"),
            ["1.  first", "more about first", "2.  second"]
        );
    }

    #[test]
    fn a_fenced_block_keeps_its_lines_verbatim() {
        let list = items("before\n\n```swift\nlet a = 1\n\n  indented\n```\n\nafter");
        assert_eq!(
            list.iter().map(|i| i.kind).collect::<Vec<_>>(),
            [ItemKind::Paragraph, ItemKind::Code, ItemKind::Paragraph]
        );
        assert_eq!(list[1].text, "let a = 1\n\n  indented");
    }

    #[test]
    fn an_unclosed_fence_still_yields_its_lines() {
        assert_eq!(texts("```\nstranded"), ["stranded"]);
    }

    #[test]
    fn quotes_and_rules_are_their_own_rows() {
        assert_eq!(
            kinds("> quoted\n> still quoted\n\n---"),
            [ItemKind::Quote, ItemKind::Rule]
        );
        assert_eq!(texts("> quoted\n> still quoted")[0], "quoted still quoted");
    }

    #[test]
    fn a_list_inside_a_quote_stays_quoted() {
        let list = items("> - one\n> - two");
        let rows: Vec<_> = list.iter().map(|i| (i.kind, i.text.as_str())).collect();
        assert_eq!(
            rows,
            [
                (ItemKind::Quote, "\u{2022}  one"),
                (ItemKind::Quote, "\u{2022}  two")
            ]
        );
    }

    #[test]
    fn an_empty_body_has_no_rows() {
        assert!(items("   \n\n").is_empty());
    }

    #[test]
    fn windows_line_endings_do_not_leak_into_the_text() {
        assert_eq!(texts("# Title\r\n\r\ntext\r\n"), ["Title", "text"]);
    }

    #[test]
    fn a_table_becomes_aligned_monospace_columns() {
        let list = items("| name | n |\n|---|--:|\n| **alpha** | 1 |\n| b | 22 |\n\nafter");
        assert_eq!(list[0].kind, ItemKind::Code);
        assert_eq!(
            list[0].text,
            "name   n\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}  \u{2500}\u{2500}\nalpha  1\nb      22"
        );
        assert_eq!(list[1].text, "after");
    }

    #[test]
    fn links_inside_a_table_are_kept() {
        let list = items("| site |\n|---|\n| [docs](https://example.test/d) |");
        assert_eq!(list[0].links[0].url, "https://example.test/d");
    }

    #[test]
    fn html_comments_and_tags_are_dropped_but_their_body_stays() {
        assert_eq!(
            texts(
                "<!-- describe your change -->\n\n<details>\n<summary>Logs</summary>\n\nthe body\n\n</details>"
            ),
            ["the body"]
        );
    }

    #[test]
    fn front_matter_is_not_shown() {
        assert_eq!(texts("---\ntitle: x\n---\n\n# Doc"), ["Doc"]);
    }

    #[test]
    fn emphasis_strike_and_code_markers_are_dropped() {
        let list = items("a **bold** and `code` and *it* and ~~gone~~");
        assert_eq!(list[0].text, "a bold and code and it and gone");
        assert!(list[0].links.is_empty());
    }

    #[test]
    fn a_link_keeps_its_label_in_the_text_and_its_url_aside() {
        let list = items("see [the docs](https://example.test/a_(b)) now");
        assert_eq!(list[0].text, "see the docs now");
        assert_eq!(
            list[0].links,
            [Link {
                label: "the docs".into(),
                url: "https://example.test/a_(b)".into()
            }]
        );
    }

    #[test]
    fn bare_urls_become_links_and_lose_trailing_punctuation() {
        let list = items("go to https://example.test/x, then <https://example.test/y>.");
        assert_eq!(
            list[0].text,
            "go to https://example.test/x, then https://example.test/y."
        );
        let urls: Vec<_> = list[0].links.iter().map(|l| l.url.as_str()).collect();
        assert_eq!(urls, ["https://example.test/x", "https://example.test/y"]);
    }

    #[test]
    fn links_are_listed_in_reading_order_without_duplicates() {
        let list = items(
            "https://example.test/a then [b](https://example.test/b) and https://example.test/a",
        );
        let urls: Vec<_> = list[0].links.iter().map(|l| l.url.as_str()).collect();
        assert_eq!(urls, ["https://example.test/a", "https://example.test/b"]);
    }

    #[test]
    fn only_links_the_app_would_open_elsewhere_are_kept() {
        let list =
            items("[run](javascript:alert(1)) and [file](file:///etc/passwd) and [rel](docs/a.md)");
        assert_eq!(list[0].text, "run and file and rel");
        assert!(list[0].links.is_empty());
    }

    #[test]
    fn an_image_shows_its_alt_text() {
        let list = items("![logo](https://example.test/l.png)");
        assert_eq!(list[0].text, "logo");
        assert_eq!(list[0].links[0].url, "https://example.test/l.png");
    }
}
