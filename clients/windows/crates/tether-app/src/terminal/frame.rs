/// One frame in flight at a time. Output that lands while a frame is on its way only
/// marks the next one dirty, and the next frame starts when the window reports the last
/// one presented. The grid therefore repaints at most once per display refresh.
#[derive(Debug, Default)]
pub struct FramePacer {
    dirty: bool,
    in_flight: bool,
}

impl FramePacer {
    pub fn mark_dirty(&mut self) -> bool {
        if self.in_flight {
            self.dirty = true;
            return false;
        }
        self.in_flight = true;
        true
    }

    pub fn presented(&mut self) -> bool {
        self.in_flight = false;
        if !self.dirty {
            return false;
        }
        self.dirty = false;
        self.in_flight = true;
        true
    }

    /// Nothing to draw after all (no active tab): free the slot.
    pub fn cancel(&mut self) {
        self.in_flight = false;
        self.dirty = false;
    }
}

/// Filled in by Task 8.
#[derive(Debug)]
pub struct FrameJob;

pub fn submit(_job: FrameJob) {}

pub fn attach_window(
    _app: &crate::AppWindow,
    _presented: std::sync::Arc<dyn Fn() + Send + Sync>,
) {
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_coalesce_while_in_flight() {
        let mut p = FramePacer::default();
        assert!(p.mark_dirty());
        for _ in 0..1000 {
            assert!(!p.mark_dirty());
        }
        assert!(p.presented());
        assert!(!p.presented());
        assert!(p.mark_dirty());
    }

    #[test]
    fn cancel_frees_the_slot() {
        let mut p = FramePacer::default();
        assert!(p.mark_dirty());
        p.cancel();
        assert!(p.mark_dirty());
    }
}
