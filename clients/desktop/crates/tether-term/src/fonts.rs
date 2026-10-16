use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use tether_core::fonts::{add_downloaded, font_named, remove_downloaded};
use tether_core::googlefonts::DownloadedFont;

macro_rules! apple_font {
    ($file:literal) => {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../apple/TetherKit/Sources/TetherKit/Resources/Fonts/",
            $file
        ))
    };
}

macro_rules! bundled_font {
    ($file:literal) => {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/",
            $file
        ))
    };
}

static CASCADIA_MONO: (&[u8], &[u8]) = (
    bundled_font!("CascadiaMono-Regular.ttf"),
    bundled_font!("CascadiaMono-Bold.ttf"),
);
static CASCADIA_CODE: (&[u8], &[u8]) = (
    bundled_font!("CascadiaCode-Regular.ttf"),
    bundled_font!("CascadiaCode-Bold.ttf"),
);
static JETBRAINS_MONO: (&[u8], &[u8]) = (
    apple_font!("JetBrainsMono-Regular.ttf"),
    apple_font!("JetBrainsMono-Bold.ttf"),
);
static MONASPACE_NEON: (&[u8], &[u8]) = (
    apple_font!("MonaspaceNeon-Regular.otf"),
    apple_font!("MonaspaceNeon-Bold.otf"),
);
static MONASPACE_RADON: (&[u8], &[u8]) = (
    apple_font!("MonaspaceRadon-Regular.otf"),
    apple_font!("MonaspaceRadon-Bold.otf"),
);
static MAPLE_MONO: (&[u8], &[u8]) = (
    apple_font!("MapleMono-Regular.ttf"),
    apple_font!("MapleMono-Bold.ttf"),
);
static COMIC_MONO: (&[u8], &[u8]) = (
    apple_font!("ComicMono.ttf"),
    apple_font!("ComicMono-Bold.ttf"),
);

pub static SYMBOLS: &[u8] = apple_font!("SymbolsNerdFontMono-Regular.ttf");

struct Downloaded {
    regular: &'static [u8],
    bold: &'static [u8],
    fingerprint: u64,
}

/// Every downloaded family this process has registered, removed ones included: the glyph
/// cache is keyed by id, so an id may only ever mean one set of bytes.
static DOWNLOADED: RwLock<Option<HashMap<String, Downloaded>>> = RwLock::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontError {
    Unreadable,
    NotMonospace,
    NeedsRestart,
}

impl std::fmt::Display for FontError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unreadable => "The downloaded file isn't a font Tether can use.",
            Self::NotMonospace => "This font isn't monospaced, so it can't draw a terminal grid.",
            Self::NeedsRestart => "Restart Tether to use the updated font.",
        })
    }
}

fn fingerprint(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0xcbf2_9ce4_8422_2325u64 ^ bytes.len() as u64, |h, b| {
            (h ^ *b as u64).wrapping_mul(0x100_0000_01b3)
        })
}

fn uniform(advances: &[f32]) -> bool {
    advances.windows(2).all(|w| (w[0] - w[1]).abs() < 0.5)
}

fn check(data: &[u8]) -> Result<(), FontError> {
    let font = swash::FontRef::from_index(data, 0).ok_or(FontError::Unreadable)?;
    let charmap = font.charmap();
    if charmap.map('A') == 0 {
        return Err(FontError::Unreadable);
    }
    let metrics = font.glyph_metrics(&[]);
    let advances: Vec<f32> = ['i', 'M', 'W', '.']
        .iter()
        .map(|c| metrics.advance_width(charmap.map(*c)))
        .collect();
    if uniform(&advances) {
        Ok(())
    } else {
        Err(FontError::NotMonospace)
    }
}

/// Makes a stored family selectable and drawable. Bytes are kept for the life of the process.
pub fn register_downloaded(
    font: &DownloadedFont,
    regular: Vec<u8>,
    bold: Option<Vec<u8>>,
) -> Result<(), FontError> {
    check(&regular)?;
    let bold = match bold {
        Some(b) if check(&b).is_ok() => b,
        _ => regular.clone(),
    };
    let id = font.id();
    let print = fingerprint(&regular) ^ fingerprint(&bold).rotate_left(1);
    let mut guard = DOWNLOADED.write().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    match map.get(&id) {
        Some(known) if known.fingerprint != print => return Err(FontError::NeedsRestart),
        Some(_) => {}
        None => {
            map.insert(
                id.clone(),
                Downloaded {
                    regular: Box::leak(regular.into_boxed_slice()),
                    bold: Box::leak(bold.into_boxed_slice()),
                    fingerprint: print,
                },
            );
        }
    }
    add_downloaded(&id, &font.family);
    Ok(())
}

/// Stops offering the family; a font id that was removed falls back like any unknown id.
pub fn unregister_downloaded(id: &str) {
    remove_downloaded(id);
}

pub fn face_bytes(id: &str) -> (&'static [u8], &'static [u8]) {
    let id = font_named(id).id;
    if let Some(d) = DOWNLOADED
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(id))
    {
        return (d.regular, d.bold);
    }
    match id {
        "cascadia-code" => CASCADIA_CODE,
        "jetbrains-mono" => JETBRAINS_MONO,
        "monaspace-neon" => MONASPACE_NEON,
        "monaspace-radon" => MONASPACE_RADON,
        "maple-mono" => MAPLE_MONO,
        "comic-mono" => COMIC_MONO,
        _ => CASCADIA_MONO,
    }
}

/// One face of a font file. A collection (`.ttc`) holds several, and the index picks one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Face {
    pub data: &'static [u8],
    pub index: u32,
}

impl Face {
    pub(crate) const fn first(data: &'static [u8]) -> Self {
        Self { data, index: 0 }
    }

    pub(crate) fn font(self) -> Option<swash::FontRef<'static>> {
        swash::FontRef::from_index(self.data, self.index as usize)
    }

    pub(crate) fn glyph(self, ch: char) -> u16 {
        self.font().map_or(0, |f| f.charmap().map(ch))
    }
}

/// Fontconfig and DirectWrite both name a face by its file and its index in that file.
type FaceKey = (PathBuf, u32);

/// System faces tried after the chosen one and the symbols. The list only grows, so a
/// `FaceSlot::System` index stays valid for the life of the process.
#[derive(Default)]
struct Fallbacks {
    faces: Vec<Face>,
    keys: Vec<FaceKey>,
    files: HashMap<PathBuf, &'static [u8]>,
    #[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
    uncovered: HashSet<char>,
}

impl Fallbacks {
    fn position(&self, key: &FaceKey) -> Option<usize> {
        self.keys.iter().position(|k| k == key)
    }

    fn push(&mut self, (path, index): FaceKey, data: &'static [u8]) -> usize {
        self.files.entry(path.clone()).or_insert(data);
        self.keys.push((path, index));
        self.faces.push(Face { data, index });
        self.faces.len() - 1
    }
}

fn fallbacks() -> &'static RwLock<Fallbacks> {
    static LOADED: OnceLock<RwLock<Fallbacks>> = OnceLock::new();
    LOADED.get_or_init(|| RwLock::new(load_system_fallbacks()))
}

pub(crate) fn system_fallback_count() -> usize {
    fallbacks()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .faces
        .len()
}

pub(crate) fn system_fallback(index: usize) -> Face {
    fallbacks()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .faces
        .get(index)
        .copied()
        .unwrap_or(Face::first(&[]))
}

/// Asks the system for a face that draws `ch` when none of the loaded ones does, and
/// returns its index. Each character is looked up at most once.
pub(crate) fn find_fallback(ch: char) -> Option<usize> {
    #[cfg(target_os = "linux")]
    {
        extend_for(fallbacks(), &fontconfig_cover, ch)
    }
    #[cfg(windows)]
    {
        extend_for(
            fallbacks(),
            &|ch| Box::new(crate::dwrite::cover(ch).into_iter()),
            ch,
        )
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = ch;
        None
    }
}

/// The bytes holding `key` when that face can draw `probe`. `known` is the file when
/// another of its faces is already loaded; a file read only to be rejected is dropped.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn usable(known: Option<&'static [u8]>, key: &FaceKey, probe: char) -> Option<&'static [u8]> {
    if let Some(data) = known {
        return draws(data, key.1, probe).then_some(data);
    }
    let bytes = std::fs::read(&key.0).ok()?;
    draws(&bytes, key.1, probe).then(|| &*Box::leak(bytes.into_boxed_slice()))
}

/// Colour emoji are loaded up front and tried first, because common symbol fonts draw
/// monochrome emoji. Everything else is looked up per character.
#[cfg(windows)]
fn load_system_fallbacks() -> Fallbacks {
    let mut loaded = Fallbacks::default();
    if let Some(key) = crate::dwrite::cover('\u{1f600}')
        && let Some(data) = usable(None, &key, '\u{1f600}')
    {
        loaded.push(key, data);
    }
    loaded
}

#[cfg(not(any(windows, target_os = "linux")))]
fn load_system_fallbacks() -> Fallbacks {
    Fallbacks::default()
}

#[cfg(target_os = "linux")]
fn load_system_fallbacks() -> Fallbacks {
    linux_fallbacks(&fontconfig_match, FALLBACK_WANTS)
}

#[cfg(target_os = "linux")]
/// What each fallback has to cover, in the order they are tried: colour emoji first, as on
/// Windows, because common symbol fonts draw monochrome emoji. Han without a language comes
/// before the explicit Chinese, Japanese and Korean faces, so fontconfig picks the regional
/// forms the user's locale asks for. A match that cannot draw its probe is dropped, since
/// fontconfig always answers with its best guess even when nothing fits.
const FALLBACK_WANTS: &[(&str, char, &[&str])] = &[
    (
        "emoji",
        '\u{1f600}',
        &["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"],
    ),
    (
        "sans-serif:charset=2603",
        '\u{2603}',
        &["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    ),
    ("sans-serif:charset=6c49", '\u{6c49}', &[]),
    (
        "sans-serif:lang=zh-cn",
        '\u{6c49}',
        &["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"],
    ),
    (
        "sans-serif:lang=ja",
        '\u{65e5}',
        &["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"],
    ),
    (
        "sans-serif:lang=ko",
        '\u{d55c}',
        &["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"],
    ),
];

/// `%{index}` carries a variable font's named instance in its high 16 bits; the face is
/// the low 16.
#[cfg(target_os = "linux")]
fn parse_face_line(line: &str) -> Option<FaceKey> {
    let (index, file) = line.split_once(' ')?;
    let index = index.parse::<u32>().ok()? & 0xffff;
    (!file.is_empty()).then(|| (PathBuf::from(file), index))
}

#[cfg(target_os = "linux")]
fn fontconfig_match(pattern: &str) -> Option<FaceKey> {
    let out = tether_core::hostcmd::host_command("fc-match")
        .args(["-f", "%{index} %{file}", pattern])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_face_line(std::str::from_utf8(&out.stdout).ok()?)
}

#[cfg(target_os = "linux")]
fn fontconfig_list(pattern: &str) -> Vec<FaceKey> {
    let Ok(out) = tether_core::hostcmd::host_command("fc-list")
        .args(["-f", "%{index} %{file}\n", pattern])
        .output()
    else {
        return Vec::new();
    };
    let mut keys: Vec<FaceKey> = Vec::new();
    for key in String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_face_line)
    {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

/// Fontconfig's best guess first; every face that claims the character only when that fails.
#[cfg(target_os = "linux")]
fn fontconfig_cover(ch: char) -> Box<dyn Iterator<Item = FaceKey>> {
    let charset = format!(":charset={:x}", ch as u32);
    let best = fontconfig_match(&format!("sans-serif{charset}"));
    let rest = std::iter::once_with(move || fontconfig_list(&charset)).flatten();
    Box::new(best.into_iter().chain(rest))
}

/// Faces read while looking for one character, so a character no font has stays cheap.
#[cfg(any(windows, target_os = "linux"))]
const MAX_TRIED_PER_CHAR: usize = 8;

#[cfg(any(windows, target_os = "linux"))]
fn extend_for(
    store: &RwLock<Fallbacks>,
    find: &dyn Fn(char) -> Box<dyn Iterator<Item = FaceKey>>,
    ch: char,
) -> Option<usize> {
    let read = || store.read().unwrap_or_else(|e| e.into_inner());
    if read().uncovered.contains(&ch) {
        return None;
    }
    let mut tried = Vec::new();
    for key in find(ch) {
        // A loaded face was already asked, and does not have it.
        if read().position(&key).is_some() || tried.contains(&key) {
            continue;
        }
        if tried.len() == MAX_TRIED_PER_CHAR {
            break;
        }
        tried.push(key.clone());
        let known = read().files.get(&key.0).copied();
        if let Some(data) = usable(known, &key, ch) {
            let mut s = store.write().unwrap_or_else(|e| e.into_inner());
            return Some(match s.position(&key) {
                Some(i) => i,
                None => s.push(key, data),
            });
        }
    }
    store
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .uncovered
        .insert(ch);
    None
}

/// Mapped is not drawn: swash paints colour tables of version 0 only, so COLRv1 emoji go
/// through `colr`, and a face neither can paint is skipped.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn draws(data: &[u8], index: u32, probe: char) -> bool {
    let Some(font) = swash::FontRef::from_index(data, index as usize) else {
        return false;
    };
    let glyph = font.charmap().map(probe);
    if glyph == 0 {
        return false;
    }
    let mut ctx = swash::scale::ScaleContext::new();
    let mut scaler = ctx.builder(font).size(16.0).build();
    swash::scale::Render::new(&[
        swash::scale::Source::ColorOutline(0),
        swash::scale::Source::ColorBitmap(swash::scale::StrikeWith::BestFit),
        swash::scale::Source::Outline,
    ])
    .render(&mut scaler, glyph)
    .is_some_and(|image| image.data.iter().any(|b| *b != 0))
        || crate::colr::rasterize(data, index, glyph, 16.0)
            .is_some_and(|image| image.data.iter().any(|b| *b != 0))
}

#[cfg(target_os = "linux")]
fn linux_fallbacks(
    find: &dyn Fn(&str) -> Option<FaceKey>,
    wants: &[(&str, char, &[&str])],
) -> Fallbacks {
    let mut loaded = Fallbacks::default();
    for (pattern, probe, well_known) in wants {
        let candidates = find(pattern)
            .into_iter()
            .chain(well_known.iter().map(|p| (PathBuf::from(p), 0)));
        for key in candidates {
            if loaded.position(&key).is_some() {
                break;
            }
            if let Some(data) = usable(loaded.files.get(&key.0).copied(), &key, *probe) {
                loaded.push(key, data);
                break;
            }
        }
    }
    loaded
}

#[cfg(test)]
mod tests {
    use super::*;
    use swash::FontRef;
    use tether_core::fonts::FONTS;

    fn maps(data: &[u8], ch: char) -> bool {
        FontRef::from_index(data, 0).is_some_and(|f| f.charmap().map(ch) != 0)
    }

    #[test]
    fn every_offered_face_has_regular_and_bold() {
        for face in FONTS.iter() {
            let (regular, bold) = face_bytes(face.id);
            assert!(maps(regular, 'A'), "{} regular", face.id);
            assert!(maps(bold, 'A'), "{} bold", face.id);
            assert_ne!(
                regular.as_ptr(),
                bold.as_ptr(),
                "{} bold is its own file",
                face.id
            );
        }
    }

    #[test]
    fn unknown_id_falls_back_to_cascadia_mono() {
        assert_eq!(
            face_bytes("menlo").0.as_ptr(),
            face_bytes("cascadia-mono").0.as_ptr()
        );
    }

    #[test]
    fn symbols_font_covers_powerline_and_nerd_icons() {
        assert!(maps(SYMBOLS, '\u{e0b0}'));
        assert!(maps(SYMBOLS, '\u{f121}'));
    }

    #[test]
    fn cascadia_mono_lacks_nerd_icons_so_fallback_matters() {
        assert!(!maps(face_bytes("cascadia-mono").0, '\u{f121}'));
    }

    fn family(slug: &str) -> DownloadedFont {
        DownloadedFont {
            family: "Test Mono".into(),
            slug: slug.into(),
            regular: "regular.ttf".into(),
            bold: Some("bold.ttf".into()),
        }
    }

    #[test]
    fn a_downloaded_family_draws_and_stops_when_removed() {
        let (regular, bold) = face_bytes("jetbrains-mono");
        let font = family("test-mono-a");
        register_downloaded(&font, regular.to_vec(), Some(bold.to_vec())).unwrap();
        let id = font.id();
        assert_eq!(font_named(&id).name, "Test Mono");
        let (r, b) = face_bytes(&id);
        assert_eq!((r, b), (regular, bold));
        // The same bytes again are fine; a family is not offered twice.
        register_downloaded(&font, regular.to_vec(), Some(bold.to_vec())).unwrap();
        assert_eq!(
            tether_core::fonts::all_fonts()
                .iter()
                .filter(|f| f.id == id)
                .count(),
            1
        );
        unregister_downloaded(&id);
        assert_eq!(font_named(&id).id, "cascadia-mono");
        assert_eq!(
            face_bytes(&id).0.as_ptr(),
            face_bytes("cascadia-mono").0.as_ptr()
        );
    }

    #[test]
    fn a_missing_bold_reuses_the_regular_face() {
        let font = family("test-mono-b");
        let (regular, _) = face_bytes("maple-mono");
        register_downloaded(&font, regular.to_vec(), None).unwrap();
        let (r, b) = face_bytes(&font.id());
        assert_eq!(r, b);
        unregister_downloaded(&font.id());
    }

    #[test]
    fn different_bytes_for_a_known_id_wait_for_a_restart() {
        let font = family("test-mono-c");
        register_downloaded(&font, face_bytes("jetbrains-mono").0.to_vec(), None).unwrap();
        assert_eq!(
            register_downloaded(&font, face_bytes("maple-mono").0.to_vec(), None),
            Err(FontError::NeedsRestart)
        );
        unregister_downloaded(&font.id());
    }

    #[test]
    fn garbage_is_not_a_font() {
        assert_eq!(
            register_downloaded(&family("test-mono-d"), b"not a font".to_vec(), None),
            Err(FontError::Unreadable)
        );
    }

    #[test]
    fn every_bundled_face_passes_the_monospace_check() {
        for face in tether_core::fonts::FONTS.iter() {
            assert_eq!(check(face_bytes(face.id).0), Ok(()), "{}", face.id);
        }
    }

    #[test]
    fn uneven_advances_are_not_monospace() {
        assert!(uniform(&[600.0, 600.0, 600.2]));
        assert!(!uniform(&[300.0, 600.0, 800.0]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fallback_that_lacks_its_probe_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let nerd = dir.path().join("nerd.ttf");
        std::fs::write(&nerd, SYMBOLS).unwrap();
        let wants: &[(&str, char, &[&str])] =
            &[("any", '\u{1f600}', &[]), ("any", '\u{f121}', &[])];
        let found = linux_fallbacks(&|_| Some((nerd.clone(), 0)), wants);
        assert_eq!(found.faces.len(), 1);
        assert_ne!(found.faces[0].glyph('\u{f121}'), 0);
        assert!(
            linux_fallbacks(&|_| None, &[("any", 'A', &[])])
                .faces
                .is_empty()
        );
        assert!(!draws(SYMBOLS, 0, '\u{1f600}'));
        assert!(draws(SYMBOLS, 0, '\u{f121}'));
        assert!(!draws(b"not a font", 0, 'A'));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_character_no_loaded_face_has_loads_the_first_one_that_draws_it() {
        let dir = tempfile::tempdir().unwrap();
        let nerd = dir.path().join("nerd.ttf");
        let emoji = dir.path().join("emoji.ttf");
        std::fs::write(&nerd, SYMBOLS).unwrap();
        std::fs::write(&emoji, crate::colr::tests::COLR_V1_EMOJI).unwrap();
        let store = RwLock::new(Fallbacks::default());
        let asked = std::cell::Cell::new(0);
        let candidates = vec![
            (dir.path().join("missing.ttf"), 0),
            (nerd, 0),
            (emoji.clone(), 0),
        ];
        let find = |_| -> Box<dyn Iterator<Item = FaceKey>> {
            asked.set(asked.get() + 1);
            Box::new(candidates.clone().into_iter())
        };

        assert_eq!(extend_for(&store, &find, '\u{1f600}'), Some(0));
        assert_eq!(store.read().unwrap().keys, vec![(emoji, 0)]);

        // Every candidate is loaded or cannot draw it: remembered, not asked again.
        assert_eq!(extend_for(&store, &find, '\u{10fffd}'), None);
        assert_eq!(extend_for(&store, &find, '\u{10fffd}'), None);
        assert_eq!(asked.get(), 2);
        assert_eq!(store.read().unwrap().faces.len(), 1);
    }

    /// Two faces of one collection: the file is read once, and each face draws from its
    /// own index.
    #[cfg(target_os = "linux")]
    #[test]
    fn faces_of_one_collection_share_the_file_and_keep_their_index() {
        let dir = tempfile::tempdir().unwrap();
        let ttc = dir.path().join("pair.ttc");
        std::fs::write(&ttc, collection(&[SYMBOLS, face_bytes("cascadia-mono").0])).unwrap();
        let store = RwLock::new(Fallbacks::default());
        let nerd = extend_for(
            &store,
            &|_| Box::new([(ttc.clone(), 0)].into_iter()),
            '\u{f121}',
        );
        let latin = extend_for(&store, &|_| Box::new([(ttc.clone(), 1)].into_iter()), 'A');
        let s = store.read().unwrap();
        let (nerd, latin) = (s.faces[nerd.unwrap()], s.faces[latin.unwrap()]);
        assert_eq!((nerd.index, latin.index), (0, 1));
        assert_eq!(nerd.data.as_ptr(), latin.data.as_ptr());
        assert_ne!(nerd.glyph('\u{f121}'), 0);
        assert_eq!(latin.glyph('\u{f121}'), 0);
    }

    /// A minimal `ttcf` wrapper: the header points at each font's table directory, whose
    /// table offsets are rebased onto the font's place in the file.
    #[cfg(target_os = "linux")]
    fn collection(fonts: &[&[u8]]) -> Vec<u8> {
        let header = 12 + 4 * fonts.len();
        let mut out = b"ttcf\x00\x01\x00\x00".to_vec();
        out.extend((fonts.len() as u32).to_be_bytes());
        let mut at = header;
        let mut starts = Vec::new();
        for font in fonts {
            starts.push(at);
            at += font.len().next_multiple_of(4);
        }
        for start in &starts {
            out.extend((*start as u32).to_be_bytes());
        }
        for (font, start) in fonts.iter().zip(starts) {
            let mut font = font.to_vec();
            let tables = u16::from_be_bytes([font[4], font[5]]) as usize;
            for t in 0..tables {
                let at = 12 + t * 16 + 8;
                let offset = u32::from_be_bytes(font[at..at + 4].try_into().unwrap());
                font[at..at + 4].copy_from_slice(&(offset + start as u32).to_be_bytes());
            }
            font.resize(font.len().next_multiple_of(4), 0);
            out.extend(font);
        }
        out
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fontconfig_lines_name_the_face_not_the_named_instance() {
        assert_eq!(
            parse_face_line("65538 /fonts/My Font.ttc"),
            Some((PathBuf::from("/fonts/My Font.ttc"), 2))
        );
        assert_eq!(parse_face_line("0 "), None);
        assert_eq!(parse_face_line("x /a.ttf"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_hosts_fallbacks_cover_emoji_and_cjk_when_installed() {
        let s = fallbacks().read().unwrap();
        let installed = |p: &str| std::path::Path::new(p).exists();
        let covers = |ch| s.faces.iter().any(|f| f.glyph(ch) != 0);
        if installed("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf") {
            assert!(covers('\u{1f600}'));
        }
        if installed("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc") {
            assert!(covers('\u{65e5}'));
            assert!(covers('\u{d55c}'));
        }
        for f in &s.faces {
            assert!(f.font().is_some());
        }
    }

    /// Scripts the old fixed list missed; any Windows install has fonts for them.
    #[cfg(windows)]
    #[test]
    fn directwrite_finds_a_face_for_any_script() {
        for ch in [
            '\u{1f600}',
            '\u{0627}',
            '\u{05d0}',
            '\u{0e01}',
            '\u{0915}',
            '\u{65e5}',
        ] {
            let i = find_fallback(ch)
                .or_else(|| {
                    (0..system_fallback_count()).find(|&i| system_fallback(i).glyph(ch) != 0)
                })
                .unwrap_or_else(|| panic!("no face for U+{:04X}", ch as u32));
            assert_ne!(system_fallback(i).glyph(ch), 0);
        }
    }
}
