//! Range selection over the existing native text inputs, without changing their layout.
//! Slint's hit-testing is internal; keep that version-pinned bridge in this module.

use std::{cell::RefCell, ops::ControlFlow, rc::Rc};

use i_slint_core::{
    accessibility::AccessibleStringProperty,
    item_tree::ItemWeak,
    items::{ItemRc, TextInput},
    lengths::{LogicalPoint, LogicalRect, LogicalSize},
    window::WindowInner,
};
use slint::ComponentHandle;

use crate::{ChatSelection, ChatSelectionScope};

#[derive(Default)]
struct Selection {
    blocks: Vec<ItemWeak>,
    anchor: (usize, usize),
    focus: (usize, usize),
    dragging: bool,
}

fn geometry(item: &ItemRc) -> LogicalRect {
    let rect = item.geometry();
    LogicalRect::new(item.map_to_window(rect.origin), rect.size)
}

fn blocks(ui: &crate::AppWindow, scope: ChatSelectionScope) -> Vec<ItemRc> {
    let bounds = LogicalRect::new(
        LogicalPoint::new(scope.x, scope.y),
        LogicalSize::new(scope.width, scope.height),
    );
    let root = ItemRc::new_root(WindowInner::from_pub(ui.window()).component());
    let mut found = Vec::new();
    root.visit_descendants(|item| {
        if item.is_visible()
            && let Some(input) = item.downcast::<TextInput>()
            && input.as_pin_ref().read_only()
            && input.as_pin_ref().enabled()
            && (if scope.id.is_empty() {
                bounds.inflate(1., 1.).contains_rect(&geometry(item))
            } else {
                item.accessible_string_property(AccessibleStringProperty::Id)
                    .is_some_and(|id| id == scope.id)
            })
        {
            found.push(item.clone());
        }
        ControlFlow::<()>::Continue(())
    });
    found.sort_by(|a, b| {
        let a = geometry(a);
        let b = geometry(b);
        a.min_y()
            .total_cmp(&b.min_y())
            .then(a.min_x().total_cmp(&b.min_x()))
    });
    found
}

impl Selection {
    fn items(&self) -> Vec<ItemRc> {
        self.blocks
            .iter()
            .map(ItemWeak::upgrade)
            .collect::<Option<Vec<_>>>()
            .unwrap_or_default()
    }

    fn clear(&mut self) {
        for item in self.items() {
            if let Some(input) = item.downcast::<TextInput>() {
                let input = input.as_pin_ref();
                input
                    .anchor_position_byte_offset
                    .set(input.cursor_position_byte_offset());
            }
        }
        *self = Self::default();
    }

    fn hit(&self, point: LogicalPoint) -> Option<(usize, usize)> {
        let items = self.items();
        let (index, item) = items.iter().enumerate().min_by(|(_, a), (_, b)| {
            let distance = |item: &ItemRc| {
                let rect = geometry(item);
                let dx = (rect.min_x() - point.x).max(0.).max(point.x - rect.max_x());
                let dy = (rect.min_y() - point.y).max(0.).max(point.y - rect.max_y());
                dx * dx + dy * dy
            };
            distance(a).total_cmp(&distance(b))
        })?;
        let input = item.downcast::<TextInput>()?;
        let adapter = item.window_adapter()?;
        let local = point - geometry(item).origin.to_vector();
        Some((
            index,
            input
                .as_pin_ref()
                .byte_offset_for_position(local, &adapter, item)
                .0,
        ))
    }

    fn paint(&self) {
        let (start, end) = if self.anchor <= self.focus {
            (self.anchor, self.focus)
        } else {
            (self.focus, self.anchor)
        };
        for (index, item) in self.items().iter().enumerate() {
            let Some(input) = item.downcast::<TextInput>() else {
                continue;
            };
            let input = input.as_pin_ref();
            let length = input.text().len();
            let a = if index == start.0 { start.1 } else { 0 };
            let b = if index == end.0 { end.1 } else { length };
            let (a, b) = if index < start.0 || index > end.0 {
                (0, 0)
            } else {
                (a, b)
            };
            input.anchor_position_byte_offset.set(a as i32);
            input.cursor_position_byte_offset.set(b as i32);
        }
    }

    fn copy(&self, all: bool) -> String {
        let mut parts = Vec::new();
        for item in self.items() {
            let Some(input) = item.downcast::<TextInput>() else {
                continue;
            };
            let input = input.as_pin_ref();
            if !input.enabled() || !item.is_visible() {
                return String::new();
            }
            let text = input.text();
            let (a, b) = if all {
                (0, text.len())
            } else {
                input.selection_anchor_and_cursor()
            };
            if a == b {
                continue;
            }
            let Some(text) = text.get(a.min(b)..a.max(b)) else {
                continue;
            };
            let code = item
                .accessible_string_property(AccessibleStringProperty::Description)
                .is_some_and(|s| s == "Code block");
            parts.push((text.to_owned(), code));
        }
        copy_parts(&parts)
    }
}

fn flatten(text: &str) -> String {
    let mut out = String::new();
    let mut after_break = false;
    for ch in text.chars() {
        if matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            if !after_break {
                while out.ends_with([' ', '\t']) {
                    out.pop();
                }
                out.push(' ');
            }
            after_break = true;
        } else if !after_break || !matches!(ch, ' ' | '\t') {
            out.push(ch);
            after_break = false;
        }
    }
    out
}

fn copy_parts(parts: &[(String, bool)]) -> String {
    let mut out = String::new();
    let mut previous_code = false;
    for (text, code) in parts {
        if !out.is_empty() {
            out.push(if *code || previous_code { '\n' } else { ' ' });
        }
        out.push_str(&if *code { text.clone() } else { flatten(text) });
        previous_code = *code;
    }
    out
}

pub fn wire(ui: &crate::AppWindow) {
    let state = Rc::new(RefCell::new(Selection::default()));
    let vm = ui.global::<ChatSelection>();
    let weak = ui.as_weak();
    let selection = state.clone();
    vm.on_pointer(move |scope, x, y, kind| {
        let Some(ui) = weak.upgrade() else { return };
        let mut selection = selection.borrow_mut();
        if kind == 0 || kind == 4 {
            let next: Vec<_> = blocks(&ui, scope).iter().map(ItemRc::downgrade).collect();
            if kind == 0 || selection.blocks != next {
                selection.clear();
                selection.blocks = next;
                if let Some(hit) = selection.hit(LogicalPoint::new(x, y)) {
                    selection.anchor = hit;
                    selection.focus = hit;
                }
            }
            selection.dragging = kind == 0;
        }
        if (kind == 0 || kind == 1 || kind == 2) && selection.dragging {
            if let Some(hit) = selection.hit(LogicalPoint::new(x, y)) {
                selection.focus = hit;
            }
            selection.paint();
        }
        if kind == 2 {
            selection.dragging = false;
        }
        if kind == 3
            && let Some((index, offset)) = selection.hit(LogicalPoint::new(x, y))
            && let Some(item) = selection.blocks.get(index).and_then(ItemWeak::upgrade)
            && let Some(input) = item.downcast::<TextInput>()
            && let Some(adapter) = item.window_adapter()
        {
            let input = input.as_pin_ref();
            input.set_selection_offsets(&adapter, &item, offset as i32, offset as i32);
            input.select_word(&adapter, &item);
            let (a, b) = input.selection_anchor_and_cursor();
            selection.anchor = (index, a);
            selection.focus = (index, b);
            selection.paint();
        }
    });
    let selection = state.clone();
    vm.on_copy(move |all| {
        let text = selection.borrow().copy(all);
        if !text.is_empty() {
            super::glue::platform().set_clipboard(&text);
        }
    });
    let selection = state.clone();
    vm.on_select_all(move || {
        let mut selection = selection.borrow_mut();
        if let Some(item) = selection.blocks.last().and_then(ItemWeak::upgrade)
            && let Some(input) = item.downcast::<TextInput>()
        {
            selection.focus = (selection.blocks.len() - 1, input.as_pin_ref().text().len());
            selection.anchor = (0, 0);
            selection.paint();
        }
    });
    vm.on_clear(move || state.borrow_mut().clear());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_drag_crosses_markdown_blocks_and_stays_in_one_message() {
        use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
        use slint::platform::{Platform, PointerEventButton, WindowAdapter, WindowEvent};
        use slint::{ModelRc, Rgb8Pixel, VecModel};

        struct Headless(Rc<MinimalSoftwareWindow>);
        impl Platform for Headless {
            fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, slint::PlatformError> {
                Ok(self.0.clone())
            }
        }
        let window = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
        slint::platform::set_platform(Box::new(Headless(window.clone()))).unwrap();
        let ui = crate::AppWindow::new().unwrap();
        wire(&ui);
        ui.global::<crate::AppBridge>()
            .set_page(crate::PageKind::Terminal);
        ui.global::<crate::ChatVm>().set_active(true);
        ui.global::<crate::ChatVm>()
            .set_rows(ModelRc::new(VecModel::from(vec![
                crate::ChatRowVm {
                    kind: 1,
                    key: "item:1".into(),
                    selectable: true,
                    markdown: ModelRc::new(VecModel::from(vec![
                        crate::MdItemVm {
                            kind: 1,
                            text: "First paragraph".into(),
                            ..Default::default()
                        },
                        crate::MdItemVm {
                            kind: 4,
                            text: "let a = 1\n  print(a)".into(),
                            ..Default::default()
                        },
                        crate::MdItemVm {
                            kind: 1,
                            text: "Last paragraph".into(),
                            ..Default::default()
                        },
                    ])),
                    ..Default::default()
                },
                crate::ChatRowVm {
                    kind: 0,
                    key: "item:2".into(),
                    text: "Another message".into(),
                    ..Default::default()
                },
            ])));
        ui.window().set_size(slint::LogicalSize::new(1000., 700.));
        ui.show().unwrap();
        let mut pixels = vec![Rgb8Pixel::default(); 1000 * 700];
        window.draw_if_needed(|renderer| {
            renderer.render(&mut pixels, 1000);
        });
        let scope = ChatSelectionScope {
            width: 1000.,
            height: 700.,
            ..Default::default()
        };
        let inputs = blocks(&ui, scope);
        let text_of = |item: &ItemRc| {
            item.downcast::<TextInput>()
                .unwrap()
                .as_pin_ref()
                .text()
                .to_string()
        };
        let first = inputs
            .iter()
            .find(|item| text_of(item) == "First paragraph")
            .expect("first paragraph");
        let last = inputs
            .iter()
            .find(|item| text_of(item) == "Last paragraph")
            .expect("last paragraph");
        let outside = inputs
            .iter()
            .find(|item| text_of(item) == "Another message")
            .expect("neighbor message");
        let a = geometry(first);
        let b = geometry(last);
        let start = slint::LogicalPosition::new(a.min_x() + 1., a.min_y() + a.height() / 2.);
        let end = slint::LogicalPosition::new(b.max_x() - 1., b.min_y() + b.height() / 2.);
        ui.window().dispatch_event(WindowEvent::PointerPressed {
            position: start,
            button: PointerEventButton::Left,
        });
        ui.window()
            .dispatch_event(WindowEvent::PointerMoved { position: end });
        ui.window().dispatch_event(WindowEvent::PointerReleased {
            position: end,
            button: PointerEventButton::Left,
        });
        let selected = Selection {
            blocks: inputs.iter().map(ItemRc::downgrade).collect(),
            ..Default::default()
        };
        assert_eq!(
            selected.copy(false),
            "First paragraph\nlet a = 1\n  print(a)\nLast paragraph"
        );
        assert!(
            !outside
                .downcast::<TextInput>()
                .unwrap()
                .as_pin_ref()
                .has_selection()
        );
        let copied = Rc::new(std::cell::Cell::new(false));
        let called = copied.clone();
        ui.global::<ChatSelection>().on_copy(move |all| {
            assert!(!all);
            called.set(true);
        });
        for event in [
            WindowEvent::KeyPressed {
                text: slint::platform::Key::Control.into(),
            },
            WindowEvent::KeyPressed { text: "c".into() },
            WindowEvent::KeyReleased { text: "c".into() },
            WindowEvent::KeyReleased {
                text: slint::platform::Key::Control.into(),
            },
        ] {
            ui.window().dispatch_event(event);
        }
        assert!(copied.get(), "Ctrl+C reaches the transcript selection");
        // Reverse the same drag to exercise the range ordering.
        ui.window().dispatch_event(WindowEvent::PointerPressed {
            position: end,
            button: PointerEventButton::Left,
        });
        ui.window()
            .dispatch_event(WindowEvent::PointerMoved { position: start });
        ui.window().dispatch_event(WindowEvent::PointerReleased {
            position: start,
            button: PointerEventButton::Left,
        });
        assert_eq!(
            selected.copy(false),
            "First paragraph\nlet a = 1\n  print(a)\nLast paragraph"
        );
        ui.global::<ChatSelection>().invoke_clear();
        assert!(selected.copy(false).is_empty());
        ui.hide().unwrap();
    }

    #[test]
    fn copied_prose_is_one_paragraph_and_code_keeps_indentation() {
        assert_eq!(
            copy_parts(&[
                ("First\r\n  paragraph".into(), false),
                ("Second\n\nparagraph".into(), false),
                ("let a = 1\n  print(a)".into(), true),
                ("Last\nline".into(), false)
            ]),
            "First paragraph Second paragraph\nlet a = 1\n  print(a)\nLast line"
        );
    }

    #[test]
    fn copied_unicode_and_code_are_verbatim() {
        assert_eq!(
            copy_parts(&[("🙂 café\n  next".into(), true)]),
            "🙂 café\n  next"
        );
        assert_eq!(flatten(" a  b\t c "), " a  b\t c ");
        assert_eq!(copy_parts(&[]), "");
    }
}
