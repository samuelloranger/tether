//! Reconstructs tappable URLs and file paths across soft-wrapped grid rows.
//!
//! Mechanical port of `apps/mobile/src/links.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

static URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(https?://[^\s]+)").expect("URL_RE"));
static FILE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\s)((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+(?::[1-9]\d*(?::[1-9]\d*)?)?)")
        .expect("FILE_RE")
});
static URL_AT_EOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)https?://\S{8,}$").expect("URL_AT_EOL_RE"));
static URL_CONT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9\-._~%+:@]*[/?#&=][^\s]*").expect("URL_CONT_RE"));
static FILE_SUFFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+$").expect("FILE_SUFFIX_RE"));
static FILE_LOC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?)?$").expect("FILE_LOC_RE"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkTarget {
    External {
        url: String,
    },
    File {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        column: Option<u32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkSpan {
    pub start: usize,
    pub end: usize,
    pub target: LinkTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSegment {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<LinkTarget>,
}

fn trim_url_end(mut url: &str) -> &str {
    while !url.is_empty() {
        let ch = url.chars().next_back().expect("url is non-empty");
        if ch == ')' {
            let opens = url.chars().filter(|c| *c == '(').count();
            let closes = url.chars().filter(|c| *c == ')').count();
            if closes <= opens {
                break;
            }
        } else if !".,;:!?'\"]}>".contains(ch) {
            break;
        }
        url = &url[..url.len() - ch.len_utf8()];
    }
    url
}

fn file_boundary_ok(joined: &str, end: usize) -> bool {
    match joined[end..].chars().next() {
        None => true,
        Some(ch) => ch.is_whitespace() || ")],;.".contains(ch),
    }
}

fn strip_file_trail(token: &str) -> &str {
    token.trim_end_matches(|c: char| ")],;.".contains(c))
}

pub fn parse_file_target(token: &str) -> Option<LinkTarget> {
    let clean = strip_file_trail(token);
    let caps = FILE_LOC_RE.captures(clean)?;
    let path = caps.get(1)?.as_str();
    if !path.contains('/') || !FILE_SUFFIX_RE.is_match(path) {
        return None;
    }
    if path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return None;
    }
    Some(LinkTarget::File {
        path: path.to_string(),
        line: caps.get(2).and_then(|m| m.as_str().parse().ok()),
        column: caps.get(3).and_then(|m| m.as_str().parse().ok()),
    })
}

fn hard_wrap_skip(row: &str, next: &str) -> i32 {
    if !URL_AT_EOL_RE.is_match(row) {
        return -1;
    }
    let body = next.trim_start();
    if body.is_empty() || !URL_CONT_RE.is_match(body) {
        return -1;
    }
    i32::try_from(next.len() - body.len()).unwrap_or(-1)
}

pub fn compute_link_spans(texts: &[String], wrapped: &[bool]) -> Vec<Vec<LinkSpan>> {
    let mut out: Vec<Vec<LinkSpan>> = texts.iter().map(|_| Vec::new()).collect();
    let mut i = 0;
    while i < texts.len() {
        let mut j = i;
        let mut skips: Vec<usize> = vec![0];
        while j + 1 < texts.len() {
            if wrapped.get(j).copied().unwrap_or(false) {
                skips.push(0);
                j += 1;
                continue;
            }
            let skip = hard_wrap_skip(&texts[j], &texts[j + 1]);
            if skip < 0 {
                break;
            }
            skips.push(usize::try_from(skip).unwrap_or(0));
            j += 1;
        }

        let mut parts: Vec<String> = Vec::new();
        let mut offs: Vec<usize> = Vec::new();
        let mut acc = 0usize;
        for k in i..=j {
            let skip = skips[k - i];
            let part = texts[k].get(skip..).unwrap_or("").to_string();
            offs.push(acc);
            acc += part.len();
            parts.push(part);
        }
        let joined = parts.join("");

        for caps in URL_RE.captures_iter(&joined) {
            let Some(full) = caps.get(0) else { continue };
            let url = trim_url_end(full.as_str());
            if url.is_empty() {
                continue;
            }
            let s = full.start();
            let e = s + url.len();
            let target = LinkTarget::External {
                url: url.to_string(),
            };
            push_row_spans(&mut out, i, j, &skips, &parts, &offs, s, e, target);
        }

        for caps in FILE_RE.captures_iter(&joined) {
            let Some(raw_m) = caps.get(1) else { continue };
            let full = caps.get(0).expect("captures always have 0");
            if !file_boundary_ok(&joined, full.end()) {
                continue;
            }
            let raw = raw_m.as_str();
            let Some(target) = parse_file_target(raw) else {
                continue;
            };
            let rel = full.as_str().find(raw).unwrap_or(0);
            let s = full.start() + rel;
            let e = s + raw.len();
            push_row_spans(&mut out, i, j, &skips, &parts, &offs, s, e, target);
        }

        i = j + 1;
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn push_row_spans(
    out: &mut [Vec<LinkSpan>],
    i: usize,
    j: usize,
    skips: &[usize],
    parts: &[String],
    offs: &[usize],
    s: usize,
    e: usize,
    target: LinkTarget,
) {
    for k in i..=j {
        let skip = skips[k - i];
        let row_start = offs[k - i];
        let row_end = row_start + parts[k - i].len();
        let a = s.max(row_start);
        let b = e.min(row_end);
        if a < b {
            out[k].push(LinkSpan {
                start: a - row_start + skip,
                end: b - row_start + skip,
                target: target.clone(),
            });
        }
    }
}

pub fn split_run_by_links(
    text: &str,
    base: usize,
    url_at: &[Option<LinkTarget>],
) -> Vec<RunSegment> {
    let mut segs = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut p = 0usize;
    while p < chars.len() {
        let target = url_at.get(base + p).cloned().flatten();
        let mut q = p + 1;
        while q < chars.len() {
            let next = url_at.get(base + q).cloned().flatten();
            if next != target {
                break;
            }
            q += 1;
        }
        segs.push(RunSegment {
            text: chars[p..q].iter().collect(),
            target,
        });
        p = q;
    }
    segs
}

pub fn url_columns(links: &[LinkSpan]) -> Vec<Option<LinkTarget>> {
    let mut url_at: Vec<Option<LinkTarget>> = Vec::new();
    for span in links {
        if span.end > url_at.len() {
            url_at.resize(span.end, None);
        }
        for cell in url_at.iter_mut().take(span.end).skip(span.start) {
            *cell = Some(span.target.clone());
        }
    }
    url_at
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(rows: &[&str]) -> Vec<String> {
        rows.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn parses_workspace_files_and_source_locations() {
        assert_eq!(
            parse_file_target("docs/superpowers/specs/design.md"),
            Some(LinkTarget::File {
                path: "docs/superpowers/specs/design.md".into(),
                line: None,
                column: None,
            })
        );
        assert_eq!(
            parse_file_target("apps/desktop/src/App.tsx:42:9"),
            Some(LinkTarget::File {
                path: "apps/desktop/src/App.tsx".into(),
                line: Some(42),
                column: Some(9),
            })
        );
        assert_eq!(parse_file_target("/etc/passwd"), None);
        assert_eq!(parse_file_target("../secret.txt"), None);
        assert_eq!(parse_file_target("plain-word"), None);
    }

    #[test]
    fn trailing_punctuation_is_not_part_of_a_url() {
        let paren = compute_link_spans(
            &texts(&["(https://selfh.st/weekly/2026-07-17/) more"]),
            &[false],
        );
        assert_eq!(
            paren[0][0].target,
            LinkTarget::External {
                url: "https://selfh.st/weekly/2026-07-17/".into(),
            }
        );
        let period = compute_link_spans(&texts(&["see https://example.com/a."]), &[false]);
        assert_eq!(
            period[0][0].target,
            LinkTarget::External {
                url: "https://example.com/a".into(),
            }
        );
    }

    #[test]
    fn balanced_parens_inside_a_url_are_kept() {
        let spans = compute_link_spans(
            &texts(&["https://en.wikipedia.org/wiki/Foo_(bar) x"]),
            &[false],
        );
        assert_eq!(
            spans[0][0].target,
            LinkTarget::External {
                url: "https://en.wikipedia.org/wiki/Foo_(bar)".into(),
            }
        );
    }

    #[test]
    fn soft_wrapped_paren_url_carries_the_whole_trimmed_url() {
        let url = "https://github.com/samuelloranger/labby";
        let line = format!("({url})");
        let spans = compute_link_spans(&texts(&[&line[..24], &line[24..]]), &[true, false]);
        let expected = LinkTarget::External { url: url.into() };
        assert_eq!(spans[0][0].target, expected);
        assert_eq!(spans[1][0].target, expected);
    }

    #[test]
    fn soft_wrapped_file_links_carry_the_whole_typed_target() {
        let path = "docs/superpowers/specs/2026-07-16-terminal-file-viewer-design.md";
        let spans = compute_link_spans(&texts(&[&path[..24], &path[24..]]), &[true, false]);
        let expected = LinkTarget::File {
            path: path.into(),
            line: None,
            column: None,
        };
        assert_eq!(spans[0][0].target, expected);
        assert_eq!(spans[1][0].target, expected);
    }

    #[test]
    fn hard_wrapped_url_is_stitched_into_one_target() {
        let url = "https://github.com/samuelloranger/tether/releases/tag/v2.0.2";
        let spans = compute_link_spans(
            &texts(&[
                "  v2.0.2 released — https://github.com/samuelloranger/teth",
                "  er/releases/tag/v2.0.2",
            ]),
            &[false, false],
        );
        let expected = LinkTarget::External { url: url.into() };
        assert_eq!(spans[0][0].target, expected);
        assert_eq!(spans[1][0].target, expected);
        assert_eq!(spans[1][0].start, 2);
        assert_eq!(spans[1][0].end, 24);
    }

    #[test]
    fn prose_after_a_complete_url_is_not_glued_onto_it() {
        let spans = compute_link_spans(
            &texts(&[
                "  v2.0.2 — https://github.com/x/releases/tag/v2.0.2",
                "  Release builds + CI in flight.",
            ]),
            &[false, false],
        );
        assert_eq!(
            spans[0][0].target,
            LinkTarget::External {
                url: "https://github.com/x/releases/tag/v2.0.2".into(),
            }
        );
        assert!(spans[1].is_empty());
    }
}
