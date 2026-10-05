use std::time::Duration;

/// A resizing grid would report sizes the PTY then has to honor: one SIGWINCH per settle.
pub const RESIZE_SETTLE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GridSize {
    pub cols: u16,
    pub rows: u16,
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(Debug, Default)]
pub struct ResizeDebouncer {
    pending: Option<(GridSize, Duration)>,
    sent: Option<GridSize>,
}

impl ResizeDebouncer {
    pub fn mark_sent(&mut self, size: GridSize) {
        self.sent = Some(size);
    }

    pub fn on_size(&mut self, size: GridSize, now: Duration) {
        self.pending = Some((size, now));
    }

    pub fn poll(&mut self, now: Duration) -> Option<GridSize> {
        let (size, at) = self.pending?;
        if now.saturating_sub(at) < RESIZE_SETTLE {
            return None;
        }
        self.pending = None;
        if self.sent == Some(size) {
            return None;
        }
        self.sent = Some(size);
        Some(size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(cols: u16, rows: u16) -> GridSize {
        GridSize {
            cols,
            rows,
            width_px: cols as u32 * 9,
            height_px: rows as u32 * 18,
        }
    }

    fn ms(v: u64) -> Duration {
        Duration::from_millis(v)
    }

    #[test]
    fn a_drag_sends_one_resize_after_the_settle_window() {
        let mut d = ResizeDebouncer::default();
        d.mark_sent(g(80, 24));
        for (i, cols) in (81..=120).enumerate() {
            d.on_size(g(cols, 30), ms(i as u64 * 16));
            assert_eq!(d.poll(ms(i as u64 * 16 + 1)), None);
        }
        let last = 39 * 16;
        assert_eq!(d.poll(ms(last + 149)), None);
        assert_eq!(d.poll(ms(last + 150)), Some(g(120, 30)));
        assert_eq!(d.poll(ms(last + 500)), None);
    }

    #[test]
    fn settling_back_on_the_sent_size_sends_nothing() {
        let mut d = ResizeDebouncer::default();
        d.mark_sent(g(80, 24));
        d.on_size(g(90, 24), ms(0));
        d.on_size(g(80, 24), ms(50));
        assert_eq!(d.poll(ms(300)), None);
    }
}
