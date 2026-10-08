//! Extra terminal fonts from Google Fonts: the same flow as the iOS `GoogleFonts`. The CSS
//! API answers a non-browser client with TrueType URLs on `fonts.gstatic.com`; the regular
//! face (closest to 400) and a 700 are downloaded and kept in the app's data folder.
//! The network sits behind `Fetch`, so everything here runs without one.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::DataDir;

pub const INDEX_FILE: &str = "fonts.json";
pub const MAX_FONT_BYTES: usize = 12 << 20;
pub const MAX_CSS_BYTES: usize = 256 << 10;
pub const MAX_INSTALLED: usize = 24;
const CSS_HOST: &str = "https://fonts.googleapis.com/css2";
const FILE_HOST: &str = "https://fonts.gstatic.com/";

/// Monospace families on Google Fonts, offered as one-tap suggestions (the iOS list).
pub const SUGGESTIONS: [&str; 22] = [
    "Fira Code",
    "IBM Plex Mono",
    "Source Code Pro",
    "Victor Mono",
    "Cascadia Code",
    "Geist Mono",
    "Martian Mono",
    "Intel One Mono",
    "Space Mono",
    "Kode Mono",
    "Roboto Mono",
    "Inconsolata",
    "Ubuntu Mono",
    "DM Mono",
    "Red Hat Mono",
    "Fragment Mono",
    "Azeret Mono",
    "Major Mono Display",
    "Xanh Mono",
    "Syne Mono",
    "VT323",
    "Share Tech Mono",
];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GoogleFontsError {
    #[error("Paste a fonts.google.com link or a family name.")]
    NotALink,
    #[error("Google Fonts has no family named “{0}”.")]
    UnknownFamily(String),
    #[error("Google Fonts answered HTTP {0}; try again later.")]
    Service(u16),
    #[error("Couldn't reach Google Fonts. Check the connection and try again.")]
    Network,
    #[error("The downloaded file isn't a font Tether can use.")]
    Unreadable,
    #[error("“{0}” is already installed. Remove it first to download it again.")]
    AlreadyInstalled(String),
    #[error("At most {MAX_INSTALLED} downloaded fonts. Remove one first.")]
    Full,
    #[error("Couldn't save the font: {0}")]
    Disk(String),
}

/// A family the user downloaded. Files live in `<fonts dir>/<slug>/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadedFont {
    pub family: String,
    pub slug: String,
    pub regular: String,
    pub bold: Option<String>,
}

impl DownloadedFont {
    /// The stored font id, in the iOS form.
    pub fn id(&self) -> String {
        format!("gf-{}", self.slug)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DownloadedFonts {
    pub items: Vec<DownloadedFont>,
}

impl DownloadedFonts {
    pub fn load(dir: &DataDir) -> io::Result<Self> {
        let mut fonts: DownloadedFonts = dir.load(INDEX_FILE)?;
        // The slug becomes a folder name: never trust one that isn't a plain slug.
        fonts.items.retain(|f| valid_slug(&f.slug));
        Ok(fonts)
    }

    pub fn save(&self, dir: &DataDir) -> io::Result<()> {
        dir.save(INDEX_FILE, self)
    }

    pub fn by_id(&self, id: &str) -> Option<&DownloadedFont> {
        self.items.iter().find(|f| f.id() == id)
    }
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 80
        && slug.chars().all(|c| c.is_alphanumeric() || c == '-')
        && !slug.starts_with('-')
}

/// The family a pasted link or name refers to: `fonts.google.com/specimen/Fira+Code`,
/// `fonts.googleapis.com/css2?family=Fira+Code:wght@400`,
/// `fonts.google.com/share?selection.family=…`, or just `Fira Code`.
pub fn family_from_input(input: &str) -> Option<String> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    let Some((scheme, rest)) = input.split_once("://") else {
        return clean_family(input);
    };
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return None;
    }
    let rest = rest.split('#').next().unwrap_or(rest);
    let (location, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (host, path) = location.split_once('/').unwrap_or((location, ""));
    let raw = match host.to_ascii_lowercase().as_str() {
        "fonts.google.com" => match path.strip_prefix("specimen/") {
            Some(tail) => tail.split('/').next().map(str::to_string),
            None => query_value(query, "selection.family"),
        },
        "fonts.googleapis.com" => query_value(query, "family"),
        _ => None,
    }?;
    clean_family(&raw)
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.to_string())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(v) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// `Fira+Code:wght@400;700|Roboto` becomes `Fira Code`.
fn clean_family(raw: &str) -> Option<String> {
    let first = raw.split('|').next().unwrap_or(raw);
    let first = first.split(':').next().unwrap_or(first).replace('+', " ");
    let decoded = percent_decode(&first);
    let name = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    let ok = !name.is_empty()
        && name.chars().count() <= 64
        && name.chars().all(|c| c.is_alphanumeric() || c == ' ');
    ok.then_some(name)
}

/// "Fira Code" becomes "fira-code".
pub fn slug(family: &str) -> String {
    family
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

pub fn css_url(family: &str, weights: bool) -> String {
    let name = family.replace(' ', "+");
    if weights {
        format!("{CSS_HOST}?family={name}:wght@400;700")
    } else {
        format!("{CSS_HOST}?family={name}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Face {
    pub weight: u32,
    pub url: String,
}

/// `@font-face` blocks with a TrueType or OpenType source on fonts.gstatic.com. Nothing else
/// is ever requested: the CSS is untrusted text.
pub fn faces(css: &str) -> Vec<Face> {
    static WEIGHT: OnceLock<Regex> = OnceLock::new();
    static SRC: OnceLock<Regex> = OnceLock::new();
    let weight = WEIGHT.get_or_init(|| Regex::new(r"font-weight:\s*(\d+)").unwrap());
    let src = SRC.get_or_init(|| {
        Regex::new(
            r#"url\((https://fonts\.gstatic\.com/[^)\s]+)\)\s*format\('(?:truetype|opentype)'\)"#,
        )
        .unwrap()
    });
    css.split("@font-face")
        .filter_map(|block| {
            let url = src.captures(block)?[1].to_string();
            let weight = weight
                .captures(block)
                .and_then(|c| c[1].parse().ok())
                .unwrap_or(400);
            Some(Face { weight, url })
        })
        .collect()
}

/// The face closest to 400, and a 700 if the family has one.
pub fn pick(faces: &[Face]) -> Option<(&Face, Option<&Face>)> {
    let regular = faces.iter().min_by_key(|f| f.weight.abs_diff(400))?;
    let bold = faces
        .iter()
        .find(|f| f.weight == 700 && f.url != regular.url);
    Some((regular, bold))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One GET. Implementations must not follow a redirect off the requested host, and must stop
/// reading at `max_bytes` (returning an error, not a short body). `Err` means no HTTP answer.
pub trait Fetch {
    fn get(&self, url: &str, max_bytes: usize) -> Result<Response, String>;
}

fn is_font(bytes: &[u8]) -> bool {
    matches!(
        bytes.get(..4),
        Some([0, 1, 0, 0]) | Some(b"OTTO") | Some(b"true") | Some(b"ttcf")
    )
}

fn extension(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"OTTO") {
        "otf"
    } else {
        "ttf"
    }
}

/// A downloaded family, written to disk and not yet registered or recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub font: DownloadedFont,
    pub regular: Vec<u8>,
    pub bold: Option<Vec<u8>>,
}

fn get_ok(fetch: &dyn Fetch, url: &str, max: usize) -> Result<Option<Vec<u8>>, GoogleFontsError> {
    let response = fetch.get(url, max).map_err(|_| GoogleFontsError::Network)?;
    match response.status {
        200 => Ok(Some(response.body)),
        400 | 404 => Ok(None),
        status => Err(GoogleFontsError::Service(status)),
    }
}

/// Downloads `input`'s family into `<fonts_dir>/<slug>/`. The folder appears only when every
/// file is complete: files go to a staging folder and move into place together.
pub fn install(
    fetch: &dyn Fetch,
    fonts_dir: &Path,
    input: &str,
    installed: &[DownloadedFont],
) -> Result<Installed, GoogleFontsError> {
    let family = family_from_input(input).ok_or(GoogleFontsError::NotALink)?;
    let slug = slug(&family);
    if installed.iter().any(|f| f.slug == slug) {
        return Err(GoogleFontsError::AlreadyInstalled(family));
    }
    if installed.len() >= MAX_INSTALLED {
        return Err(GoogleFontsError::Full);
    }
    // A family without a 700 answers the weighted request with a 400.
    let css = match get_ok(fetch, &css_url(&family, true), MAX_CSS_BYTES)? {
        Some(css) => css,
        None => get_ok(fetch, &css_url(&family, false), MAX_CSS_BYTES)?
            .ok_or_else(|| GoogleFontsError::UnknownFamily(family.clone()))?,
    };
    let css = String::from_utf8_lossy(&css);
    let all = faces(&css);
    let (regular, bold) =
        pick(&all).ok_or_else(|| GoogleFontsError::UnknownFamily(family.clone()))?;

    let download = |face: &Face| -> Result<Vec<u8>, GoogleFontsError> {
        debug_assert!(face.url.starts_with(FILE_HOST));
        let bytes =
            get_ok(fetch, &face.url, MAX_FONT_BYTES)?.ok_or(GoogleFontsError::Service(404))?;
        if is_font(&bytes) {
            Ok(bytes)
        } else {
            Err(GoogleFontsError::Unreadable)
        }
    };
    let regular_bytes = download(regular)?;
    let bold_bytes = bold.map(download).transpose()?;

    let regular_name = format!("regular.{}", extension(&regular_bytes));
    let bold_name = bold_bytes
        .as_ref()
        .map(|b| format!("bold.{}", extension(b)));
    let disk = |e: io::Error| GoogleFontsError::Disk(e.to_string());
    let staging = fonts_dir.join(format!(
        ".staging-{slug}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let write = || -> io::Result<()> {
        fs::create_dir_all(&staging)?;
        fs::write(staging.join(&regular_name), &regular_bytes)?;
        if let (Some(name), Some(bytes)) = (&bold_name, &bold_bytes) {
            fs::write(staging.join(name), bytes)?;
        }
        let folder = fonts_dir.join(&slug);
        // An unrecorded folder is a crash's leftover.
        if folder.exists() {
            fs::remove_dir_all(&folder)?;
        }
        fs::rename(&staging, &folder)
    };
    if let Err(e) = write() {
        let _ = fs::remove_dir_all(&staging);
        return Err(disk(e));
    }
    Ok(Installed {
        font: DownloadedFont {
            family,
            slug,
            regular: regular_name,
            bold: bold_name,
        },
        regular: regular_bytes,
        bold: bold_bytes,
    })
}

pub fn folder(fonts_dir: &Path, font: &DownloadedFont) -> PathBuf {
    fonts_dir.join(&font.slug)
}

/// A stored family's bytes. An error means a file is gone, and the caller stops offering it.
pub fn read_files(
    fonts_dir: &Path,
    font: &DownloadedFont,
) -> io::Result<(Vec<u8>, Option<Vec<u8>>)> {
    let dir = folder(fonts_dir, font);
    let regular = fs::read(dir.join(&font.regular))?;
    let bold = match &font.bold {
        Some(name) => fs::read(dir.join(name)).ok(),
        None => None,
    };
    Ok((regular, bold))
}

pub fn remove_files(fonts_dir: &Path, font: &DownloadedFont) {
    if valid_slug(&font.slug) {
        let _ = fs::remove_dir_all(folder(fonts_dir, font));
    }
}

/// At launch: staging folders and families the index does not list are an interrupted
/// install or removal. Only directories are touched.
pub fn clean_up(fonts_dir: &Path, saved: &[DownloadedFont]) {
    let Ok(entries) = fs::read_dir(fonts_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
        if is_dir && (name.starts_with('.') || !saved.iter().any(|f| f.slug == name)) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const TTF: &[u8] = &[0, 1, 0, 0, 9, 9, 9, 9];

    #[derive(Default)]
    struct FakeFetch {
        replies: HashMap<String, Result<Response, String>>,
        asked: RefCell<Vec<String>>,
    }

    impl FakeFetch {
        fn ok(mut self, url: &str, body: &[u8]) -> Self {
            self.replies.insert(
                url.into(),
                Ok(Response {
                    status: 200,
                    body: body.to_vec(),
                }),
            );
            self
        }
        fn status(mut self, url: &str, status: u16) -> Self {
            self.replies.insert(
                url.into(),
                Ok(Response {
                    status,
                    body: vec![],
                }),
            );
            self
        }
    }

    impl Fetch for FakeFetch {
        fn get(&self, url: &str, _max: usize) -> Result<Response, String> {
            self.asked.borrow_mut().push(url.into());
            self.replies
                .get(url)
                .cloned()
                .unwrap_or(Err("offline".into()))
        }
    }

    fn css(blocks: &[(u32, &str)]) -> String {
        blocks
            .iter()
            .map(|(w, u)| {
                format!(
                    "/* latin */\n@font-face {{\n  font-family: 'Fira Code';\n  font-style: normal;\n  font-weight: {w};\n  src: url({u}) format('truetype');\n}}\n"
                )
            })
            .collect()
    }

    const REG: &str = "https://fonts.gstatic.com/s/a/regular.ttf";
    const BOLD: &str = "https://fonts.gstatic.com/s/a/bold.ttf";

    #[test]
    fn links_and_names_resolve_to_a_family() {
        for input in [
            "Fira Code",
            "  fira   code  ",
            "https://fonts.google.com/specimen/Fira+Code",
            "https://fonts.google.com/specimen/Fira+Code?query=fira",
            "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&display=swap",
            "https://fonts.google.com/share?selection.family=Fira+Code:wght@400",
            "https://fonts.googleapis.com/css?family=Fira%20Code|Roboto",
        ] {
            let got = family_from_input(input);
            assert!(
                got.as_deref()
                    .is_some_and(|f| f.eq_ignore_ascii_case("fira code")),
                "{input:?} -> {got:?}"
            );
        }
    }

    #[test]
    fn other_hosts_and_junk_are_refused() {
        for input in [
            "",
            "   ",
            "https://example.com/specimen/Fira+Code",
            "ftp://fonts.google.com/specimen/Fira+Code",
            "https://fonts.google.com/",
            "Fira/Code",
            "a;b",
            "../../etc",
            &"x".repeat(65),
        ] {
            assert_eq!(family_from_input(input), None, "{input:?}");
        }
    }

    #[test]
    fn slug_and_css_url() {
        assert_eq!(slug("Fira Code"), "fira-code");
        assert_eq!(slug("VT323"), "vt323");
        assert_eq!(
            css_url("Fira Code", true),
            "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700"
        );
        assert_eq!(
            css_url("Fira Code", false),
            "https://fonts.googleapis.com/css2?family=Fira+Code"
        );
    }

    #[test]
    fn only_gstatic_truetype_sources_count() {
        let body = format!(
            "{}@font-face {{ font-weight: 400; src: url(https://evil.example/x.ttf) format('truetype'); }}\n\
             @font-face {{ font-weight: 400; src: url(https://fonts.gstatic.com/s/a/w.woff2) format('woff2'); }}",
            css(&[(400, REG), (700, BOLD)])
        );
        let f = faces(&body);
        assert_eq!(
            f,
            vec![
                Face {
                    weight: 400,
                    url: REG.into()
                },
                Face {
                    weight: 700,
                    url: BOLD.into()
                }
            ]
        );
    }

    #[test]
    fn pick_takes_the_face_nearest_400_and_a_distinct_700() {
        let f = faces(&css(&[
            (200, "https://fonts.gstatic.com/s/l.ttf"),
            (500, REG),
            (700, BOLD),
        ]));
        let (regular, bold) = pick(&f).unwrap();
        assert_eq!((regular.weight, bold.map(|b| b.weight)), (500, Some(700)));
        let only = faces(&css(&[(700, BOLD)]));
        let (regular, bold) = pick(&only).unwrap();
        assert_eq!((regular.weight, bold), (700, None));
        assert!(pick(&[]).is_none());
    }

    fn fetcher() -> FakeFetch {
        FakeFetch::default()
            .ok(
                &css_url("Fira Code", true),
                css(&[(400, REG), (700, BOLD)]).as_bytes(),
            )
            .ok(REG, TTF)
            .ok(BOLD, b"OTTOxxxx")
    }

    #[test]
    fn installs_regular_and_bold_into_a_family_folder() {
        let dir = tempfile::tempdir().unwrap();
        let got = install(&fetcher(), dir.path(), "Fira Code", &[]).unwrap();
        assert_eq!(got.font.id(), "gf-fira-code");
        assert_eq!(got.font.regular, "regular.ttf");
        assert_eq!(got.font.bold.as_deref(), Some("bold.otf"));
        let (r, b) = read_files(dir.path(), &got.font).unwrap();
        assert_eq!((r.as_slice(), b.as_deref()), (TTF, Some(&b"OTTOxxxx"[..])));
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, ["fira-code"]);
    }

    #[test]
    fn a_family_without_700_retries_unweighted() {
        let dir = tempfile::tempdir().unwrap();
        let fetch = FakeFetch::default()
            .status(&css_url("Fira Code", true), 400)
            .ok(&css_url("Fira Code", false), css(&[(400, REG)]).as_bytes())
            .ok(REG, TTF);
        let got = install(&fetch, dir.path(), "Fira Code", &[]).unwrap();
        assert_eq!(got.font.bold, None);
        assert_eq!(got.bold, None);
    }

    #[test]
    fn failures_say_why_and_leave_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let none = |dir: &Path| fs::read_dir(dir).unwrap().count() == 0;

        assert_eq!(
            install(&fetcher(), dir.path(), "", &[]),
            Err(GoogleFontsError::NotALink)
        );
        let unknown = FakeFetch::default()
            .status(&css_url("Nope Mono", true), 400)
            .status(&css_url("Nope Mono", false), 404);
        assert_eq!(
            install(&unknown, dir.path(), "Nope Mono", &[]),
            Err(GoogleFontsError::UnknownFamily("Nope Mono".into()))
        );
        let down = FakeFetch::default().status(&css_url("Fira Code", true), 503);
        assert_eq!(
            install(&down, dir.path(), "Fira Code", &[]),
            Err(GoogleFontsError::Service(503))
        );
        assert_eq!(
            install(&FakeFetch::default(), dir.path(), "Fira Code", &[]),
            Err(GoogleFontsError::Network)
        );
        let junk = FakeFetch::default()
            .ok(&css_url("Fira Code", true), css(&[(400, REG)]).as_bytes())
            .ok(REG, b"<html>not a font</html>");
        assert_eq!(
            install(&junk, dir.path(), "Fira Code", &[]),
            Err(GoogleFontsError::Unreadable)
        );
        // The bold face failing after the regular one succeeded installs nothing.
        let half = FakeFetch::default()
            .ok(
                &css_url("Fira Code", true),
                css(&[(400, REG), (700, BOLD)]).as_bytes(),
            )
            .ok(REG, TTF)
            .status(BOLD, 500);
        assert_eq!(
            install(&half, dir.path(), "Fira Code", &[]),
            Err(GoogleFontsError::Service(500))
        );
        assert!(none(dir.path()));
    }

    #[test]
    fn an_installed_family_is_refused_without_a_request() {
        let dir = tempfile::tempdir().unwrap();
        let first = install(&fetcher(), dir.path(), "Fira Code", &[]).unwrap();
        let fetch = fetcher();
        assert_eq!(
            install(
                &fetch,
                dir.path(),
                "fira code",
                std::slice::from_ref(&first.font)
            ),
            Err(GoogleFontsError::AlreadyInstalled("fira code".into()))
        );
        assert!(fetch.asked.borrow().is_empty());
    }

    #[test]
    fn the_index_round_trips_and_drops_unsafe_slugs() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let good = DownloadedFont {
            family: "Fira Code".into(),
            slug: "fira-code".into(),
            regular: "regular.ttf".into(),
            bold: None,
        };
        let bad = DownloadedFont {
            slug: "../escape".into(),
            ..good.clone()
        };
        DownloadedFonts {
            items: vec![good.clone(), bad],
        }
        .save(&data)
        .unwrap();
        let loaded = DownloadedFonts::load(&data).unwrap();
        assert_eq!(loaded.items, vec![good.clone()]);
        assert_eq!(loaded.by_id("gf-fira-code"), Some(&good));
        assert_eq!(loaded.by_id("cascadia-mono"), None);
    }

    #[test]
    fn clean_up_removes_staging_and_unlisted_folders_only() {
        let dir = tempfile::tempdir().unwrap();
        let got = install(&fetcher(), dir.path(), "Fira Code", &[]).unwrap();
        fs::create_dir(dir.path().join(".staging-x-1")).unwrap();
        fs::create_dir(dir.path().join("orphan")).unwrap();
        fs::write(dir.path().join(INDEX_FILE), "{}").unwrap();
        clean_up(dir.path(), std::slice::from_ref(&got.font));
        let mut names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, ["fira-code", INDEX_FILE]);
        remove_files(dir.path(), &got.font);
        assert!(!dir.path().join("fira-code").exists());
        assert!(read_files(dir.path(), &got.font).is_err());
    }
}
