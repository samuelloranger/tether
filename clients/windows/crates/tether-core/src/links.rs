use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSpan {
    pub start: usize,
    pub end: usize,
    pub url: String,
}

static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s│┃⎿]+").unwrap());
static URL_AT_EOL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\s│┃])https?://(\S*)$").unwrap());
static URL_CONT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9\-._~%+:@]*[/?#&=][^\s]*").unwrap());

/// Box drawing a TUI frames output with (`│ … │`, Claude Code's `⎿`): a URL it wraps
/// continues past these, not through them.
const BORDERS: [char; 3] = ['│', '┃', '⎿'];

/// Chars to drop from the end of a row closing on a box border: the border and one gutter
/// space. Wider padding means the text stopped short of the edge, so nothing wrapped.
fn trailing_border(row: &[char]) -> usize {
    let mut end = row.len();
    while end > 0 && row[end - 1].is_whitespace() {
        end -= 1;
    }
    if end == 0 || !BORDERS.contains(&row[end - 1]) || row[end - 1] == '⎿' {
        return 0;
    }
    end -= 1;
    if end > 0 && row[end - 1] == ' ' {
        end -= 1;
    }
    row.len() - end
}

fn hard_wrap_skip(row: &[char], next: &[char], continued: Option<(usize, usize)>, cols: Option<usize>) -> Option<usize> {
    let body = &row[..row.len() - trailing_border(row)];
    match continued {
        Some((lead, edge)) => {
            let rest = body.get(lead..).unwrap_or(&[]);
            if rest.is_empty() || rest.iter().any(|c| c.is_whitespace()) || body.len() + 1 < edge {
                return None;
            }
        }
        None => {
            let text: String = body.iter().collect();
            let caps = URL_AT_EOL.captures(&text)?;
            let tail = caps.get(1).map_or(0, |m| m.as_str().chars().count());
            // A URL cut at the edge wraps however little of it fits; one that stops short of
            // the edge needs some length to read as cut rather than done.
            let reaches_edge = trailing_border(row) > 0 || cols.is_some_and(|c| row.len() >= c);
            if !reaches_edge && tail < 8 {
                return None;
            }
        }
    }
    let lead = next.iter().take_while(|c| c.is_whitespace() || BORDERS.contains(c)).count();
    let rest: String = next[lead..].iter().collect();
    (!rest.is_empty() && URL_CONT.is_match(&rest)).then_some(lead)
}

fn trim_url_end(url: &str) -> String {
    let mut u: Vec<char> = url.chars().collect();
    while let Some(&ch) = u.last() {
        if ch == ')' {
            let opens = u.iter().filter(|&&c| c == '(').count();
            let closes = u.iter().filter(|&&c| c == ')').count();
            if closes <= opens {
                break;
            }
        } else if !".,;:!?'\"]}>".contains(ch) {
            break;
        }
        u.pop();
    }
    u.into_iter().collect()
}

pub fn detect_links(texts: &[String], wrapped: &[bool], cols: Option<usize>) -> Vec<Vec<LinkSpan>> {
    let rows: Vec<Vec<char>> = texts.iter().map(|t| t.chars().collect()).collect();
    let mut out = vec![Vec::new(); rows.len()];
    let mut i = 0;
    while i < rows.len() {
        let mut j = i;
        let mut skips = vec![0usize];
        let mut tails = Vec::new();
        while j + 1 < rows.len() {
            if wrapped.get(j).copied().unwrap_or(false) {
                skips.push(0);
                tails.push(0);
                j += 1;
                continue;
            }
            // Past the first row, a URL keeps going only through rows as wide as its first.
            let continued = (j > i).then(|| (*skips.last().unwrap(), rows[i].len() - trailing_border(&rows[i])));
            let Some(skip) = hard_wrap_skip(&rows[j], &rows[j + 1], continued, cols) else { break };
            skips.push(skip);
            tails.push(trailing_border(&rows[j]));
            j += 1;
        }
        tails.push(0);

        let mut parts: Vec<&[char]> = Vec::new();
        let mut offs = Vec::new();
        let mut acc = 0;
        for k in i..=j {
            let (skip, tail) = (skips[k - i], tails[k - i]);
            let mut part = &rows[k][..];
            if skip > 0 && skip <= part.len() {
                part = &part[skip..];
            }
            if tail > 0 && tail <= part.len() {
                part = &part[..part.len() - tail];
            }
            parts.push(part);
            offs.push(acc);
            acc += part.len();
        }
        let joined: String = parts.iter().flat_map(|p| p.iter()).collect();

        for m in URL.find_iter(&joined) {
            let url = trim_url_end(m.as_str());
            if url.is_empty() {
                continue;
            }
            let s = joined[..m.start()].chars().count();
            let e = s + url.chars().count();
            for k in i..=j {
                let row_start = offs[k - i];
                let row_end = row_start + parts[k - i].len();
                let (a, b) = (s.max(row_start), e.min(row_end));
                if a < b {
                    let skip = skips[k - i];
                    out[k].push(LinkSpan { start: a - row_start + skip, end: b - row_start + skip, url: url.clone() });
                }
            }
        }
        i = j + 1;
    }
    out
}

/// OSC 8 links come first in each row, so `link_at` finds them before detected text.
pub fn merge_links(explicit: Vec<Vec<LinkSpan>>, detected: Vec<Vec<LinkSpan>>) -> Vec<Vec<LinkSpan>> {
    let rows = explicit.len().max(detected.len());
    let mut explicit = explicit.into_iter();
    let mut detected = detected.into_iter();
    (0..rows)
        .map(|_| {
            let mut row = explicit.next().unwrap_or_default();
            row.extend(detected.next().unwrap_or_default());
            row
        })
        .collect()
}

pub fn link_at(spans: &[Vec<LinkSpan>], row: usize, col: usize) -> Option<&LinkSpan> {
    spans.get(row)?.iter().find(|s| col >= s.start && col < s.end)
}

pub fn is_openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| s.to_string()).collect()
    }

    fn urls(spans: &[Vec<LinkSpan>]) -> Vec<Vec<(usize, usize, &str)>> {
        spans.iter().map(|r| r.iter().map(|s| (s.start, s.end, s.url.as_str())).collect()).collect()
    }

    #[test]
    fn finds_a_url_and_trims_trailing_punctuation() {
        let t = rows(&["see https://example.com/a?b=1)."]);
        assert_eq!(urls(&detect_links(&t, &[false], None)), vec![vec![(4, 29, "https://example.com/a?b=1")]]);
        let t = rows(&["(https://en.wikipedia.org/wiki/Rust_(language))"]);
        assert_eq!(detect_links(&t, &[false], None)[0][0].url, "https://en.wikipedia.org/wiki/Rust_(language)");
    }

    #[test]
    fn a_soft_wrapped_url_spans_both_rows() {
        let t = rows(&["go https://example.com/aaaa", "bbbb/cc next"]);
        let spans = detect_links(&t, &[true, false], Some(27));
        let full = "https://example.com/aaaabbbb/cc";
        assert_eq!(urls(&spans), vec![vec![(3, 27, full)], vec![(0, 7, full)]]);
    }

    #[test]
    fn a_url_cut_by_claude_code_box_borders_resolves_whole() {
        let t = rows(&["│ see https://example.com/very/long/pa │", "│ th/to/file                           │"]);
        let spans = detect_links(&t, &[false, false], Some(40));
        let full = "https://example.com/very/long/path/to/file";
        assert_eq!(spans[0], vec![LinkSpan { start: 6, end: 38, url: full.into() }]);
        assert_eq!(spans[1], vec![LinkSpan { start: 2, end: 12, url: full.into() }]);
    }

    #[test]
    fn a_url_after_the_tool_output_marker_continues_on_the_next_row() {
        let first = "  ⎿  https://example.com/aaaaaaaaaaaa";
        let t = rows(&[first, "     bbbb/cc"]);
        let spans = detect_links(&t, &[false, false], Some(first.chars().count()));
        assert_eq!(spans[1][0].url, "https://example.com/aaaaaaaaaaaabbbb/cc");
    }

    #[test]
    fn prose_on_the_next_row_does_not_join() {
        let t = rows(&["read https://example.com/docs", "and then more"]);
        let spans = detect_links(&t, &[false, false], Some(29));
        assert_eq!(spans[0][0].url, "https://example.com/docs");
        assert!(spans[1].is_empty());
    }

    #[test]
    fn osc8_wins_over_detected_text() {
        let detected = detect_links(&rows(&["https://shown.example"]), &[false], None);
        let explicit = vec![vec![LinkSpan { start: 0, end: 21, url: "https://real.example".into() }]];
        let merged = merge_links(explicit, detected);
        assert_eq!(link_at(&merged, 0, 5).unwrap().url, "https://real.example");
        assert!(link_at(&merged, 0, 21).is_none());
        assert!(link_at(&merged, 3, 0).is_none());
    }

    #[test]
    fn only_http_https_and_mailto_open() {
        assert!(is_openable("https://x.y"));
        assert!(is_openable("HTTP://x.y"));
        assert!(is_openable("mailto:a@b.c"));
        assert!(!is_openable("file:///C:/Windows/system32/calc.exe"));
        assert!(!is_openable("javascript:alert(1)"));
        assert!(!is_openable("ms-settings:"));
    }
}
