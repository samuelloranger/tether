use std::cell::{Cell, RefCell};

use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Page {
    Home,
    ServerForm { editing: Option<Uuid> },
    KeyGenerate,
    KeyImport,
    KeyPaste,
    Settings,
    SchemePicker,
    FontPicker,
    Terminal,
    HostKeyRefused,
    CouldntConnect,
    Snippets,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialog {
    RemoveMachine(Uuid),
    DeleteKey(Uuid),
    DeleteSnippet(Uuid),
}

/// Pages that Esc leaves. Terminal and connect pages handle Esc themselves.
pub fn escape_is_back(page: &Page) -> bool {
    !matches!(
        page,
        Page::Home | Page::Terminal | Page::HostKeyRefused | Page::CouldntConnect
    )
}

pub struct Router {
    stack: RefCell<Vec<Page>>,
    dialog: Cell<Option<Dialog>>,
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

impl Router {
    pub fn new() -> Self {
        Self {
            stack: RefCell::new(vec![Page::Home]),
            dialog: Cell::new(None),
        }
    }

    pub fn current(&self) -> Page {
        self.stack.borrow().last().cloned().unwrap_or(Page::Home)
    }

    pub fn go(&self, page: Page) {
        self.dialog.set(None);
        self.stack.borrow_mut().push(page);
    }

    pub fn back(&self) {
        self.dialog.set(None);
        let mut stack = self.stack.borrow_mut();
        if stack.len() > 1 {
            stack.pop();
        }
    }

    #[allow(dead_code)]
    pub fn home(&self) {
        self.dialog.set(None);
        self.stack.borrow_mut().truncate(1);
    }

    pub fn dialog(&self) -> Option<Dialog> {
        self.dialog.get()
    }

    pub fn open_dialog(&self, dialog: Dialog) {
        self.dialog.set(Some(dialog));
    }

    pub fn close_dialog(&self) {
        self.dialog.set(None);
    }

    pub fn on_escape(&self) -> bool {
        if self.dialog.take().is_some() {
            return true;
        }
        if escape_is_back(&self.current()) {
            self.back();
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_home_and_back_never_pops_home() {
        let r = Router::new();
        assert_eq!(r.current(), Page::Home);
        r.back();
        assert_eq!(r.current(), Page::Home);
    }

    #[test]
    fn settings_returns_to_where_it_was_opened() {
        let r = Router::new();
        r.go(Page::Settings);
        r.go(Page::SchemePicker);
        r.back();
        assert_eq!(r.current(), Page::Settings);
        r.back();
        assert_eq!(r.current(), Page::Home);
    }

    #[test]
    fn escape_closes_a_dialog_first_then_goes_back() {
        let r = Router::new();
        r.go(Page::ServerForm { editing: None });
        r.open_dialog(Dialog::RemoveMachine(Uuid::nil()));
        assert!(r.on_escape());
        assert_eq!(r.dialog(), None);
        assert_eq!(r.current(), Page::ServerForm { editing: None });
        assert!(r.on_escape());
        assert_eq!(r.current(), Page::Home);
    }

    #[test]
    fn escape_on_home_is_not_handled() {
        let r = Router::new();
        assert!(!r.on_escape());
    }

    #[test]
    fn navigating_dismisses_a_dialog_and_home_clears_the_stack() {
        let r = Router::new();
        r.go(Page::Settings);
        r.open_dialog(Dialog::DeleteKey(Uuid::nil()));
        r.go(Page::FontPicker);
        assert_eq!(r.dialog(), None);
        r.home();
        assert_eq!(r.current(), Page::Home);
        r.back();
        assert_eq!(r.current(), Page::Home);
    }

    #[test]
    fn escape_on_terminal_is_not_back() {
        assert!(!escape_is_back(&Page::Terminal));
    }
}
