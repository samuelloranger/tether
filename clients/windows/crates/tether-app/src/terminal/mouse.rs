use tether_core::keymap::Mods;
use tether_term::{Cell, MouseMode, MouseTracking};

pub const DOUBLE_CLICK_MS: u64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKind {
    Down,
    Up,
    Move,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MouseMsg {
    pub kind: MouseKind,
    pub button: Button,
    pub mods: Mods,
    pub x_px: f32,
    pub y_px: f32,
    pub at_ms: u64,
}

#[derive(Debug, Default)]
pub struct ClickCounter {
    last: Option<(u64, Cell)>,
    count: u8,
}

impl ClickCounter {
    pub fn press(&mut self, at_ms: u64, cell: Cell) -> u8 {
        let chained = self
            .last
            .is_some_and(|(t, c)| c == cell && at_ms.saturating_sub(t) < DOUBLE_CLICK_MS);
        self.count = if chained && self.count < 3 {
            self.count + 1
        } else {
            1
        };
        self.last = Some((at_ms, cell));
        self.count
    }
}

#[derive(Debug, Default)]
pub struct PointerState {
    pub cell: Option<Cell>,
    pub held: Option<Button>,
    pub clicks: ClickCounter,
    pub wheel_acc: f32,
}

fn code(b: Button) -> u8 {
    match b {
        Button::Left => 0,
        Button::Middle => 1,
        Button::Right => 2,
        Button::None => 3,
    }
}

fn mod_bits(m: Mods) -> u8 {
    (m.shift as u8) * 4 + (m.alt as u8) * 8 + (m.ctrl as u8) * 16
}

fn report(mode: MouseMode, cb: u8, cell: Cell, release: bool) -> Option<Vec<u8>> {
    let (x, y) = (cell.col + 1, cell.row + 1);
    if mode.sgr {
        return Some(format!("\x1b[<{cb};{x};{y}{}", if release { 'm' } else { 'M' }).into_bytes());
    }
    if x > 223 || y > 223 {
        return None;
    }
    Some(vec![0x1b, b'[', b'M', 32 + cb, 32 + x as u8, 32 + y as u8])
}

pub fn encode_mouse(
    mode: MouseMode,
    kind: MouseKind,
    button: Button,
    cell: Cell,
    mods: Mods,
    held: Option<Button>,
) -> Option<Vec<u8>> {
    let (cb, release) = match (mode.tracking, kind) {
        (MouseTracking::None, _) => return None,
        (_, MouseKind::Down) if button == Button::None => return None,
        (_, MouseKind::Down) => (code(button), false),
        (_, MouseKind::Up) => (if mode.sgr { code(button) } else { 3 }, true),
        (MouseTracking::Motion, MouseKind::Move) => (32 + held.map_or(3, code), false),
        (MouseTracking::Drag, MouseKind::Move) if held.is_some() => {
            (32 + held.map_or(3, code), false)
        }
        (_, MouseKind::Move) => return None,
    };
    report(mode, cb + mod_bits(mods), cell, release)
}

pub fn encode_wheel(mode: MouseMode, up: bool, cell: Cell, mods: Mods) -> Option<Vec<u8>> {
    if mode.tracking == MouseTracking::None {
        return None;
    }
    report(mode, if up { 64 } else { 65 } + mod_bits(mods), cell, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_term::{MouseMode, MouseTracking};

    const SGR_CLICK: MouseMode = MouseMode {
        tracking: MouseTracking::Click,
        sgr: true,
    };
    const X10_CLICK: MouseMode = MouseMode {
        tracking: MouseTracking::Click,
        sgr: false,
    };
    fn cell(row: usize, col: usize) -> Cell {
        Cell { row, col }
    }
    const NONE: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
    };

    #[test]
    fn sgr_press_and_release() {
        assert_eq!(
            encode_mouse(
                SGR_CLICK,
                MouseKind::Down,
                Button::Left,
                cell(2, 4),
                NONE,
                None
            )
            .unwrap(),
            b"\x1b[<0;5;3M"
        );
        assert_eq!(
            encode_mouse(
                SGR_CLICK,
                MouseKind::Up,
                Button::Left,
                cell(2, 4),
                NONE,
                None
            )
            .unwrap(),
            b"\x1b[<0;5;3m"
        );
        assert_eq!(
            encode_mouse(
                SGR_CLICK,
                MouseKind::Down,
                Button::Right,
                cell(0, 0),
                NONE,
                None
            )
            .unwrap(),
            b"\x1b[<2;1;1M"
        );
    }

    #[test]
    fn x10_press_and_release_and_its_coordinate_limit() {
        assert_eq!(
            encode_mouse(
                X10_CLICK,
                MouseKind::Down,
                Button::Left,
                cell(2, 4),
                NONE,
                None
            )
            .unwrap(),
            vec![0x1b, b'[', b'M', 32, 37, 35]
        );
        assert_eq!(
            encode_mouse(
                X10_CLICK,
                MouseKind::Up,
                Button::Left,
                cell(2, 4),
                NONE,
                None
            )
            .unwrap(),
            vec![0x1b, b'[', b'M', 35, 37, 35]
        );
        assert_eq!(
            encode_mouse(
                X10_CLICK,
                MouseKind::Down,
                Button::Left,
                cell(0, 300),
                NONE,
                None
            ),
            None
        );
    }

    #[test]
    fn motion_follows_the_tracking_mode() {
        let drag = MouseMode {
            tracking: MouseTracking::Drag,
            sgr: true,
        };
        let motion = MouseMode {
            tracking: MouseTracking::Motion,
            sgr: true,
        };
        assert_eq!(
            encode_mouse(
                SGR_CLICK,
                MouseKind::Move,
                Button::None,
                cell(0, 0),
                NONE,
                Some(Button::Left)
            ),
            None
        );
        assert_eq!(
            encode_mouse(drag, MouseKind::Move, Button::None, cell(0, 0), NONE, None),
            None
        );
        assert_eq!(
            encode_mouse(
                drag,
                MouseKind::Move,
                Button::None,
                cell(0, 0),
                NONE,
                Some(Button::Left)
            )
            .unwrap(),
            b"\x1b[<32;1;1M"
        );
        assert_eq!(
            encode_mouse(
                motion,
                MouseKind::Move,
                Button::None,
                cell(0, 0),
                NONE,
                None
            )
            .unwrap(),
            b"\x1b[<35;1;1M"
        );
    }

    #[test]
    fn modifiers_add_their_bits_and_nothing_reports_without_tracking() {
        let ctrl_alt = Mods {
            shift: false,
            alt: true,
            ctrl: true,
        };
        assert_eq!(
            encode_mouse(
                SGR_CLICK,
                MouseKind::Down,
                Button::Left,
                cell(0, 0),
                ctrl_alt,
                None
            )
            .unwrap(),
            b"\x1b[<24;1;1M"
        );
        let off = MouseMode {
            tracking: MouseTracking::None,
            sgr: true,
        };
        assert_eq!(
            encode_mouse(off, MouseKind::Down, Button::Left, cell(0, 0), NONE, None),
            None
        );
    }

    #[test]
    fn wheel_is_buttons_64_and_65() {
        assert_eq!(
            encode_wheel(SGR_CLICK, true, cell(0, 0), NONE).unwrap(),
            b"\x1b[<64;1;1M"
        );
        assert_eq!(
            encode_wheel(SGR_CLICK, false, cell(0, 0), NONE).unwrap(),
            b"\x1b[<65;1;1M"
        );
        assert_eq!(
            encode_wheel(X10_CLICK, true, cell(0, 0), NONE).unwrap(),
            vec![0x1b, b'[', b'M', 96, 33, 33]
        );
    }

    #[test]
    fn clicks_count_up_to_three_on_one_cell_inside_the_window() {
        let mut c = ClickCounter::default();
        assert_eq!(c.press(0, cell(1, 1)), 1);
        assert_eq!(c.press(200, cell(1, 1)), 2);
        assert_eq!(c.press(400, cell(1, 1)), 3);
        assert_eq!(c.press(500, cell(1, 1)), 1);
        assert_eq!(c.press(600, cell(1, 2)), 1);
        assert_eq!(c.press(1_200, cell(1, 2)), 1);
    }
}
