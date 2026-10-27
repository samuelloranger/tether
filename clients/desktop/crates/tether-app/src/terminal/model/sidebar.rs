use super::*;
use tether_core::sidebar::{Shown, visibility};

#[derive(Debug, Default)]
pub(crate) struct SidebarState {
    /// The saved choice: the toggle closed it while the window was wide enough to dock it.
    closed: bool,
    /// Shown over the content of a window too narrow to dock it; never saved.
    overlay: bool,
    /// Unknown until the first layout, and read as wide.
    width: Option<f32>,
    shown: Option<Shown>,
}

impl SidebarState {
    fn visibility(&self) -> Shown {
        visibility(
            !self.closed,
            self.overlay,
            self.width.unwrap_or(f32::INFINITY),
        )
    }
}

impl TerminalModel {
    pub fn set_sidebar_closed(&mut self, closed: bool) {
        self.sidebar.closed = closed;
    }

    pub(crate) fn toggle_sidebar(&mut self, fx: &mut Vec<Effect>) {
        match self.sidebar.visibility() {
            Shown::Overlay => self.sidebar.overlay = false,
            Shown::Hidden if self.sidebar_narrow() => self.sidebar.overlay = true,
            _ => {
                self.sidebar.closed = !self.sidebar.closed;
                fx.push(Effect::Ui(UiEffect::RememberSidebar {
                    closed: self.sidebar.closed,
                }));
            }
        }
        self.publish_sidebar(fx);
    }

    pub(crate) fn on_window_width(&mut self, width: f32, fx: &mut Vec<Effect>) {
        self.sidebar.width = Some(width);
        if !self.sidebar_narrow() {
            self.sidebar.overlay = false;
        }
        self.publish_sidebar(fx);
    }

    pub(crate) fn on_sidebar_dismiss(&mut self, fx: &mut Vec<Effect>) {
        self.sidebar.overlay = false;
        self.publish_sidebar(fx);
    }

    fn sidebar_narrow(&self) -> bool {
        visibility(true, false, self.sidebar.width.unwrap_or(f32::INFINITY)) != Shown::Docked
    }

    fn publish_sidebar(&mut self, fx: &mut Vec<Effect>) {
        let shown = self.sidebar.visibility();
        if self.sidebar.shown != Some(shown) {
            self.sidebar.shown = Some(shown);
            fx.push(Effect::Ui(UiEffect::Sidebar(shown)));
        }
    }
}
