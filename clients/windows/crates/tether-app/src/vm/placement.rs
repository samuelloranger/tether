use tether_core::{
    WindowPlacement,
    prefs::{MIN_CLIENT_HEIGHT, MIN_CLIENT_WIDTH},
};

pub fn restore(
    saved: Option<&WindowPlacement>,
    visible: impl Fn(&WindowPlacement) -> bool,
) -> Option<WindowPlacement> {
    let mut p = *saved?;
    p.width = p.width.max(MIN_CLIENT_WIDTH);
    p.height = p.height.max(MIN_CLIENT_HEIGHT);
    visible(&p).then_some(p)
}

pub fn capture(
    bounds: WindowPlacement,
    minimized: bool,
    previous: Option<&WindowPlacement>,
) -> Option<WindowPlacement> {
    if minimized {
        return previous.copied();
    }
    if bounds.maximized {
        if let Some(prev) = previous {
            return Some(WindowPlacement {
                maximized: true,
                ..*prev
            });
        }
    }
    Some(bounds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: i32, y: i32, width: u32, height: u32, maximized: bool) -> WindowPlacement {
        WindowPlacement {
            x,
            y,
            width,
            height,
            maximized,
        }
    }

    #[test]
    fn nothing_saved_restores_nothing() {
        assert_eq!(restore(None, |_| true), None);
    }

    #[test]
    fn visible_placement_is_kept() {
        let saved = p(100, 80, 1200, 800, true);
        assert_eq!(restore(Some(&saved), |_| true), Some(saved));
    }

    #[test]
    fn offscreen_placement_is_dropped() {
        let saved = p(4000, 200, 1200, 800, false);
        assert_eq!(restore(Some(&saved), |_| false), None);
    }

    #[test]
    fn a_tiny_saved_size_grows_to_the_minimum() {
        let restored = restore(Some(&p(0, 0, 100, 50, false)), |_| true).unwrap();
        assert_eq!(
            (restored.width, restored.height),
            (MIN_CLIENT_WIDTH, MIN_CLIENT_HEIGHT)
        );
    }

    #[test]
    fn maximized_close_keeps_the_normal_bounds() {
        let normal = p(100, 80, 1200, 800, false);
        let got = capture(p(0, 0, 2560, 1400, true), false, Some(&normal)).unwrap();
        assert_eq!(got, p(100, 80, 1200, 800, true));
    }

    #[test]
    fn minimized_close_keeps_the_previous_placement() {
        let normal = p(100, 80, 1200, 800, false);
        assert_eq!(
            capture(p(-32000, -32000, 160, 28, false), true, Some(&normal)),
            Some(normal)
        );
        assert_eq!(
            capture(p(-32000, -32000, 160, 28, false), true, None),
            None
        );
    }

    #[test]
    fn normal_close_saves_the_bounds() {
        let now = p(10, 20, 900, 600, false);
        assert_eq!(capture(now, false, None), Some(now));
    }
}
