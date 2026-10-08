//! Saved window placement on Linux. Positions are physical and only X11 can set or read them;
//! sizes are logical pixels, because a Wayland window does not know its monitor's scale until it
//! is shown.

use tether_core::WindowPlacement;

/// A monitor as `(x, y, width, height)` in physical pixels.
pub type MonitorRect = (i32, i32, u32, u32);

pub fn logical_size(physical: (u32, u32), scale: f32) -> (u32, u32) {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let f = |v: u32| (v as f32 / scale).round() as u32;
    (f(physical.0), f(physical.1))
}

/// The same rule as the Windows build: a 40 px strip of the title bar must touch a monitor.
pub fn strip_on_screen(p: &WindowPlacement, monitors: &[MonitorRect]) -> bool {
    let (left, top) = (i64::from(p.x), i64::from(p.y));
    let (right, bottom) = (left + i64::from(p.width), top + 40);
    monitors.iter().any(|&(x, y, w, h)| {
        let (x, y) = (i64::from(x), i64::from(y));
        left < x + i64::from(w) && right > x && top < y + i64::from(h) && bottom > y
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: i32, y: i32, width: u32) -> WindowPlacement {
        WindowPlacement {
            x,
            y,
            width,
            height: 600,
            maximized: false,
        }
    }
    const SCREEN: MonitorRect = (0, 0, 1920, 1080);

    #[test]
    fn a_window_on_a_monitor_is_visible() {
        assert!(strip_on_screen(&at(100, 80, 1200), &[SCREEN]));
        assert!(strip_on_screen(&at(-1100, 10, 1200), &[SCREEN]));
    }

    #[test]
    fn a_window_left_on_an_unplugged_monitor_is_not() {
        assert!(!strip_on_screen(&at(2400, 80, 1200), &[SCREEN]));
        assert!(!strip_on_screen(&at(100, 1200, 1200), &[SCREEN]));
        assert!(!strip_on_screen(&at(100, 80, 1200), &[]));
    }

    #[test]
    fn a_second_monitor_counts() {
        let right = (1920, 0, 1920, 1080);
        assert!(strip_on_screen(&at(2400, 80, 1200), &[SCREEN, right]));
    }

    #[test]
    fn sizes_are_saved_as_logical_pixels() {
        assert_eq!(logical_size((2080, 1360), 2.0), (1040, 680));
        assert_eq!(logical_size((1040, 680), 1.0), (1040, 680));
        assert_eq!(logical_size((1560, 1020), 1.5), (1040, 680));
        assert_eq!(logical_size((100, 100), 0.0), (100, 100));
    }
}
