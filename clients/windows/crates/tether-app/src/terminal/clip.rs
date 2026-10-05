#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct Fake {
        busy_for: Cell<u32>,
        text: Option<String>,
        files: Option<Vec<PathBuf>>,
        png: Option<Vec<u8>>,
        dib: Option<Vec<u8>>,
        log: RefCell<Vec<&'static str>>,
    }

    impl ClipboardSource for Fake {
        fn open(&self) -> bool {
            self.log.borrow_mut().push("open");
            if self.busy_for.get() > 0 { self.busy_for.set(self.busy_for.get() - 1); return false; }
            true
        }
        fn close(&self) { self.log.borrow_mut().push("close"); }
        fn text(&self) -> Option<String> { self.text.clone() }
        fn files(&self) -> Option<Vec<PathBuf>> { self.files.clone() }
        fn png(&self) -> Option<Vec<u8>> { self.png.clone() }
        fn dibv5(&self) -> Option<Vec<u8>> { None }
        fn dib(&self) -> Option<Vec<u8>> { self.dib.clone() }
    }

    fn one_red_pixel_dib() -> Vec<u8> {
        let mut d = vec![0u8; 40];
        d[0..4].copy_from_slice(&40u32.to_le_bytes());
        d[4..8].copy_from_slice(&1i32.to_le_bytes());
        d[8..12].copy_from_slice(&1i32.to_le_bytes());
        d[12..14].copy_from_slice(&1u16.to_le_bytes());
        d[14..16].copy_from_slice(&24u16.to_le_bytes());
        d.extend([0, 0, 255, 0]);
        d
    }

    #[test]
    fn busy_clipboard_pastes_nothing() {
        let f = Fake { busy_for: Cell::new(99), text: Some("x".into()), ..Default::default() };
        let sleeps = Cell::new(0);
        assert_eq!(snapshot(&f, &|_| sleeps.set(sleeps.get() + 1)), ClipboardSnapshot::Empty);
        assert_eq!(f.log.borrow().iter().filter(|l| **l == "open").count(), OPEN_TRIES as usize);
        assert_eq!(sleeps.get(), OPEN_TRIES - 1);
        assert!(!f.log.borrow().contains(&"close"));
    }

    #[test]
    fn a_briefly_held_clipboard_is_read_on_retry() {
        let f = Fake { busy_for: Cell::new(2), text: Some("hi".into()), ..Default::default() };
        assert_eq!(snapshot(&f, &|_| {}), ClipboardSnapshot::Text("hi".into()));
        assert_eq!(f.log.borrow().last(), Some(&"close"));
    }

    #[test]
    fn text_wins_over_an_image() {
        let f = Fake { text: Some("hi".into()), dib: Some(one_red_pixel_dib()), ..Default::default() };
        assert_eq!(snapshot(&f, &|_| {}), ClipboardSnapshot::Text("hi".into()));
    }

    #[test]
    fn an_image_alone_becomes_png() {
        let f = Fake { dib: Some(one_red_pixel_dib()), ..Default::default() };
        let ClipboardSnapshot::Image(png) = snapshot(&f, &|_| {}) else { panic!("expected an image") };
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn a_registered_png_is_used_as_is() {
        let f = Fake { png: Some(b"\x89PNG\r\n\x1a\nrest".to_vec()), dib: Some(one_red_pixel_dib()), ..Default::default() };
        assert_eq!(snapshot(&f, &|_| {}), ClipboardSnapshot::Image(b"\x89PNG\r\n\x1a\nrest".to_vec()));
    }

    #[test]
    fn explorer_files_become_a_drop() {
        let f = Fake { files: Some(vec![PathBuf::from(r"C:\a.png")]), ..Default::default() };
        assert_eq!(snapshot(&f, &|_| {}), ClipboardSnapshot::Files(vec![PathBuf::from(r"C:\a.png")]));
    }

    #[test]
    fn an_empty_clipboard_is_empty() {
        assert_eq!(snapshot(&Fake::default(), &|_| {}), ClipboardSnapshot::Empty);
    }
}
