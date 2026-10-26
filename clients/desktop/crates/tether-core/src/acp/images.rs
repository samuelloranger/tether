use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// What state and journal keep of an image: enough to find the file and lay the row out, never the bytes.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ImageRef {
    /// Lowercase hex SHA-256 of the bytes, which is also the file name.
    pub id: String,
    pub mime_type: String,
    #[serde(default)]
    pub pixel_width: Option<u32>,
    #[serde(default)]
    pub pixel_height: Option<u32>,
    pub byte_count: usize,
}

impl ImageRef {
    pub fn accessibility_label(&self) -> String {
        match (self.pixel_width, self.pixel_height) {
            (Some(w), Some(h)) => format!("Image, {w} by {h}"),
            _ => "Image".to_string(),
        }
    }
}

/// Where a decoder hands image bytes before the reducer sees only the reference.
pub trait ImageSink: Send + Sync {
    fn write(&self, data: &[u8], r: &ImageRef);
}

/// An image the user is sending: base64 data and its declared type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub mime_type: String,
    pub data: String,
}

/// Past this many decoded bytes a block is skipped, not stored.
pub const MAX_DECODED_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub r: ImageRef,
    pub data: Vec<u8>,
}

/// Nil for anything that is not a believable image: bad base64, nothing decoded, too large, or
/// bytes that neither sniff nor measure as an image.
pub fn prepare_base64(encoded: &str, mime_type: Option<&str>) -> Option<Prepared> {
    if encoded.len() > MAX_DECODED_BYTES / 3 * 4 + 8 {
        return None;
    }
    let data = decode_lenient(encoded)?;
    if data.is_empty() || data.len() > MAX_DECODED_BYTES {
        return None;
    }
    prepare_data(&data, mime_type)
}

/// Unknown characters (whitespace, line breaks) are skipped and padding is optional.
fn decode_lenient(encoded: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = encoded
        .bytes()
        .filter(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/')
        .collect();
    let config = base64::engine::GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true);
    base64::engine::GeneralPurpose::new(&base64::alphabet::STANDARD, config)
        .decode(clean)
        .ok()
}

pub fn prepare_data(data: &[u8], mime_type: Option<&str>) -> Option<Prepared> {
    if data.is_empty() || data.len() > MAX_DECODED_BYTES {
        return None;
    }
    let size = imagesize::blob_size(data).ok();
    let detected = imagesize::image_type(data).ok().and_then(mime_of);
    let declared = mime_type
        .map(str::to_lowercase)
        .filter(|m| m.starts_with("image/"));
    let sniffed = sniff(data);
    if sniffed.is_none() && size.is_none() {
        return None;
    }
    let mime = sniffed
        .map(str::to_string)
        .or(detected)
        .or(declared)
        .unwrap_or_else(|| "image/jpeg".to_string());
    let id = Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Some(Prepared {
        r: ImageRef {
            id,
            mime_type: mime,
            pixel_width: size.as_ref().map(|s| s.width as u32),
            pixel_height: size.as_ref().map(|s| s.height as u32),
            byte_count: data.len(),
        },
        data: data.to_vec(),
    })
}

fn mime_of(kind: imagesize::ImageType) -> Option<String> {
    use imagesize::ImageType as T;
    let mime = match kind {
        T::Png => "image/png",
        T::Jpeg => "image/jpeg",
        T::Gif => "image/gif",
        T::Webp => "image/webp",
        T::Heif(_) => "image/heic",
        T::Bmp => "image/bmp",
        T::Tiff => "image/tiff",
        _ => return None,
    };
    Some(mime.to_string())
}

/// The type by magic bytes: an agent's declared type is not trusted and is often missing.
pub fn sniff(data: &[u8]) -> Option<&'static str> {
    let head = &data[..data.len().min(16)];
    let has = |bytes: &[u8], at: usize| {
        head.len() >= at + bytes.len() && &head[at..at + bytes.len()] == bytes
    };
    if has(&[0x89, 0x50, 0x4E, 0x47], 0) {
        return Some("image/png");
    }
    if has(&[0xFF, 0xD8, 0xFF], 0) {
        return Some("image/jpeg");
    }
    if has(&[0x47, 0x49, 0x46, 0x38], 0) {
        return Some("image/gif");
    }
    if has(&[0x52, 0x49, 0x46, 0x46], 0) && has(&[0x57, 0x45, 0x42, 0x50], 8) {
        return Some("image/webp");
    }
    if has(&[0x66, 0x74, 0x79, 0x70], 4) {
        let brand = String::from_utf8_lossy(&head[8..head.len().min(12)]).into_owned();
        if [
            "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1",
        ]
        .contains(&brand.as_str())
        {
            return Some("image/heic");
        }
    }
    None
}

pub const DEFAULT_BUDGET: u64 = 300 * 1024 * 1024;
pub const DIRECTORY_SUFFIX: &str = ".images";

/// A chat's images as content-addressed files next to its other local files, so they go with
/// the chat when it is deleted.
#[derive(Debug)]
pub struct ImageStore {
    directory: PathBuf,
    budget: u64,
    budget_root: PathBuf,
    lock: Mutex<()>,
}

impl ImageStore {
    /// `budget_root` is where every chat's image folder lives, so the cap spans chats.
    pub fn new(directory: PathBuf, budget_root: PathBuf, budget: u64) -> Self {
        Self {
            directory,
            budget,
            budget_root,
            lock: Mutex::new(()),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn path(&self, r: &ImageRef) -> PathBuf {
        self.directory.join(&r.id)
    }

    pub fn exists(&self, r: &ImageRef) -> bool {
        self.path(r).is_file()
    }

    /// Stores an attachment the user is sending.
    pub fn put(&self, attachment: &ImageAttachment) -> Option<ImageRef> {
        let prepared = prepare_base64(&attachment.data, Some(&attachment.mime_type))?;
        self.write(&prepared.data, &prepared.r);
        Some(prepared.r)
    }

    pub fn remove_all(&self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

impl ImageSink for ImageStore {
    /// Idempotent: a file already there is only touched, so a replay keeps its images the newest.
    fn write(&self, data: &[u8], r: &ImageRef) {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let target = self.path(r);
        if target.is_file() {
            if let Ok(f) = fs::OpenOptions::new().write(true).open(&target) {
                let _ = f.set_modified(SystemTime::now());
            }
            return;
        }
        if crate::store::write_atomic(&target, data).is_err() {
            return;
        }
        evict(&self.budget_root, self.budget, &target);
    }
}

/// Oldest files go first until the total, across chats, is back under the cap.
fn evict(root: &Path, budget: u64, kept: &Path) {
    let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total = 0u64;
    collect(root, &mut entries, &mut total);
    if total <= budget {
        return;
    }
    entries.sort_by_key(|e| e.2);
    for (path, size, _) in entries {
        if total <= budget {
            break;
        }
        if path == kept {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn collect(dir: &Path, out: &mut Vec<(PathBuf, u64, SystemTime)>, total: &mut u64) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect(&path, out, total);
            continue;
        }
        let in_images = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(DIRECTORY_SUFFIX));
        if in_images && meta.is_file() {
            *total += meta.len();
            out.push((
                path,
                meta.len(),
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ));
        }
    }
}

#[cfg(test)]
pub(crate) mod testimg {
    /// A PNG header with the given size; the body is only filler (`seed` keeps hashes apart).
    pub fn png(width: u32, height: u32, seed: u8) -> Vec<u8> {
        let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
        v.extend_from_slice(&[0, 0, 0, 0]);
        v.extend_from_slice(b"IEND");
        v.extend(std::iter::repeat_n(seed, 16));
        v
    }

    pub fn jpeg(width: u16, height: u16, seed: u8) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0];
        v.extend_from_slice(&[0xFF, 0xC0, 0, 17, 8]);
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v.extend(std::iter::repeat_n(seed, 16));
        v
    }

    pub fn b64(data: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(data)
    }
}

#[cfg(test)]
mod tests {
    use super::testimg::*;
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_png_gets_its_size_type_and_hash() {
        let data = png(8, 6, 1);
        let p = prepare_data(&data, None).unwrap();
        assert_eq!(p.r.mime_type, "image/png");
        assert_eq!((p.r.pixel_width, p.r.pixel_height), (Some(8), Some(6)));
        assert_eq!(p.r.byte_count, data.len());
        assert_eq!(p.r.id.len(), 64);
        assert_eq!(p.data, data);
    }

    #[test]
    fn a_missing_mime_type_is_sniffed_from_the_bytes() {
        assert_eq!(
            prepare_data(&png(2, 2, 0), None).unwrap().r.mime_type,
            "image/png"
        );
        assert_eq!(
            prepare_data(&jpeg(2, 2, 0), None).unwrap().r.mime_type,
            "image/jpeg"
        );
        let mut gif = b"GIF89a".to_vec();
        gif.extend([0; 10]);
        assert_eq!(sniff(&gif), Some("image/gif"));
        let mut webp = b"RIFF".to_vec();
        webp.extend([0; 4]);
        webp.extend(b"WEBPVP8 ");
        assert_eq!(sniff(&webp), Some("image/webp"));
        let mut heic = vec![0; 4];
        heic.extend(b"ftypheic");
        assert_eq!(sniff(&heic), Some("image/heic"));
        assert_eq!(sniff(b"hello world"), None);
    }

    #[test]
    fn a_wrong_declared_type_loses_to_the_bytes() {
        let p = prepare_data(&jpeg(3, 3, 0), Some("image/png")).unwrap();
        assert_eq!(p.r.mime_type, "image/jpeg");
    }

    #[test]
    fn sniffed_bytes_without_a_readable_size_are_still_accepted() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend([0; 2]);
        let p = prepare_data(&gif, None).unwrap();
        assert_eq!(p.r.mime_type, "image/gif");
        assert_eq!(p.r.pixel_width, None);
        assert_eq!(p.r.accessibility_label(), "Image");
    }

    #[test]
    fn bad_base64_or_non_image_bytes_are_ignored() {
        assert!(prepare_base64("%%%%", Some("image/png")).is_none());
        assert!(prepare_base64(&b64(b"not an image at all"), Some("image/png")).is_none());
        assert!(prepare_base64("", Some("image/png")).is_none());
    }

    #[test]
    fn an_oversize_image_is_skipped() {
        let mut big = png(1, 1, 0);
        big.resize(MAX_DECODED_BYTES + 1, 0);
        assert!(prepare_data(&big, Some("image/png")).is_none());
        assert!(prepare_base64(&b64(&big), Some("image/png")).is_none());
    }

    #[test]
    fn base64_tolerates_whitespace_and_missing_padding() {
        let data = png(4, 4, 9);
        let spaced = b64(&data)
            .trim_end_matches('=')
            .chars()
            .collect::<Vec<_>>()
            .chunks(20)
            .map(|c| c.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(prepare_base64(&spaced, None).unwrap().data, data);
    }

    #[test]
    fn the_accessibility_label_names_the_size() {
        let r = ImageRef {
            id: "x".into(),
            mime_type: "image/png".into(),
            pixel_width: Some(1920),
            pixel_height: Some(1080),
            byte_count: 1,
        };
        assert_eq!(r.accessibility_label(), "Image, 1920 by 1080");
    }

    fn store(root: &Path, chat: &str, budget: u64) -> ImageStore {
        ImageStore::new(
            root.join("host").join(format!("{chat}{DIRECTORY_SUFFIX}")),
            root.to_path_buf(),
            budget,
        )
    }

    #[test]
    fn files_are_content_addressed_and_written_once() {
        let root = tempfile::tempdir().unwrap();
        let s = store(root.path(), "chat", DEFAULT_BUDGET);
        let data = png(8, 6, 1);
        let r = prepare_data(&data, None).unwrap().r;
        s.write(&data, &r);
        s.write(&data, &r);
        assert!(s.exists(&r));
        assert_eq!(fs::read(s.path(&r)).unwrap(), data);
        assert_eq!(fs::read_dir(s.directory()).unwrap().count(), 1);
    }

    #[test]
    fn put_refuses_what_is_not_an_image() {
        let root = tempfile::tempdir().unwrap();
        let s = store(root.path(), "c", DEFAULT_BUDGET);
        let bad = |d: &str| ImageAttachment {
            mime_type: "image/jpeg".into(),
            data: d.into(),
        };
        assert!(s.put(&bad("")).is_none());
        assert!(s.put(&bad("@@")).is_none());
        let ok = s
            .put(&ImageAttachment {
                mime_type: "image/png".into(),
                data: b64(&png(2, 2, 0)),
            })
            .unwrap();
        assert!(s.exists(&ok));
    }

    #[test]
    fn removing_a_chat_removes_its_images_and_only_its_own() {
        let root = tempfile::tempdir().unwrap();
        let one = store(root.path(), "one", DEFAULT_BUDGET);
        let two = store(root.path(), "two", DEFAULT_BUDGET);
        let att = |seed| ImageAttachment {
            mime_type: "image/png".into(),
            data: b64(&png(2, 2, seed)),
        };
        let a = one.put(&att(1)).unwrap();
        let b = two.put(&att(2)).unwrap();
        one.remove_all();
        assert!(!one.exists(&a));
        assert!(two.exists(&b));
    }

    #[test]
    fn the_oldest_files_go_first_across_chats_and_the_newest_stays() {
        let root = tempfile::tempdir().unwrap();
        let first = png(64, 64, 1);
        let second = png(64, 64, 2);
        let a = prepare_data(&first, None).unwrap().r;
        let b = prepare_data(&second, None).unwrap().r;
        let budget = first.len() as u64 + 10;
        let one = store(root.path(), "one", budget);
        let two = store(root.path(), "two", budget);
        one.write(&first, &a);
        let old = SystemTime::now() - Duration::from_secs(100);
        fs::OpenOptions::new()
            .write(true)
            .open(one.path(&a))
            .unwrap()
            .set_modified(old)
            .unwrap();
        two.write(&second, &b);
        assert!(!one.exists(&a), "oldest evicted");
        assert!(two.exists(&b), "the file just written is kept");
    }

    #[test]
    fn a_missing_file_is_reported_not_thrown() {
        let root = tempfile::tempdir().unwrap();
        let r = ImageRef {
            id: "a".repeat(64),
            mime_type: "image/png".into(),
            pixel_width: Some(1),
            pixel_height: Some(1),
            byte_count: 1,
        };
        assert!(!store(root.path(), "c", DEFAULT_BUDGET).exists(&r));
    }
}
