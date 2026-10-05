use std::sync::Arc;

use slint::{ComponentHandle, ModelRc, VecModel};
use tether_core::osc::ProgressState;

use crate::terminal::driver::MsgSink;
use crate::terminal::frame::FrameJob;
use crate::terminal::model::{CapsuleView, Msg, TabView, TerminalView, UiEffect};
use crate::terminal::status::Lamp;
use crate::win32::Platform;
use crate::{AppWindow, TermTab, TerminalVm};

pub trait UiPort: Send + 'static {
    fn apply(&self, fx: UiEffect);
    fn view(&self, view: TerminalView);
    fn render(&self, job: FrameJob);
}

pub fn lamp_index(l: Lamp) -> i32 {
    match l {
        Lamp::Warning => 0,
        Lamp::Success => 1,
        Lamp::Danger => 2,
    }
}

pub fn progress_index(s: &ProgressState) -> i32 {
    match s {
        ProgressState::Normal => 0,
        ProgressState::Error => 1,
        ProgressState::Indeterminate => 2,
        ProgressState::Paused => 3,
    }
}

pub fn tab_items_from(tabs: &[TabView]) -> Vec<TermTab> {
    tabs.iter()
        .map(|t| TermTab {
            name: t.name.as_str().into(),
            cwd: t.cwd_leaf.clone().unwrap_or_default().into(),
            active: t.active,
            attention: t.attention,
            has_progress: t.progress.is_some(),
            progress: t
                .progress
                .as_ref()
                .map(|p| p.percent as f32 / 100.0)
                .unwrap_or(0.0),
            progress_state: t
                .progress
                .as_ref()
                .map(|p| progress_index(&p.state))
                .unwrap_or(0),
        })
        .collect()
}

pub struct SlintUi {
    pub window: slint::Weak<AppWindow>,
    pub platform: Arc<dyn Platform>,
    pub send: MsgSink,
}

impl UiPort for SlintUi {
    fn apply(&self, fx: UiEffect) {
        let (platform, send) = (self.platform.clone(), self.send.clone());
        match fx {
            // Off the UI thread: a held clipboard retries, and a big DIB takes time to encode.
            UiEffect::ReadClipboard => {
                std::thread::spawn(move || {
                    let clip = platform.read_clipboard();
                    let now_unix = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    send(Msg::Paste { clip, now_unix });
                });
            }
            fx @ (UiEffect::FlashTaskbar
            | UiEffect::Taskbar(_)
            | UiEffect::Toast { .. }
            | UiEffect::OpenUrl(_)
            | UiEffect::SetClipboard(_)
            | UiEffect::BringToFront) => {
                let _ = slint::invoke_from_event_loop(move || match fx {
                    UiEffect::FlashTaskbar => platform.flash_taskbar(),
                    UiEffect::Taskbar(p) => platform.set_progress(p.as_ref()),
                    UiEffect::Toast {
                        session,
                        title,
                        body,
                    } => platform.toast(&session, &title, &body),
                    UiEffect::OpenUrl(url) => platform.open_url(&url),
                    UiEffect::SetClipboard(text) => platform.set_clipboard(&text),
                    UiEffect::BringToFront => platform.bring_to_front(),
                    _ => {}
                });
            }
            other => {
                let _ = self
                    .window
                    .upgrade_in_event_loop(move |w| crate::terminal::glue::apply_on_ui(&w, other));
            }
        }
    }

    fn view(&self, view: TerminalView) {
        let _ = self.window.upgrade_in_event_loop(move |w| {
            let vm = w.global::<TerminalVm>();
            vm.set_machine(view.header.machine.as_str().into());
            vm.set_session(view.header.session.as_str().into());
            vm.set_word(view.header.word.into());
            vm.set_lamp(lamp_index(view.header.lamp));
            vm.set_tabs(ModelRc::new(VecModel::from(tab_items_from(&view.tabs))));
            vm.set_empty(view.empty.is_some());
            vm.set_empty_title(
                view.empty
                    .as_ref()
                    .map(|e| e.title.as_str())
                    .unwrap_or("")
                    .into(),
            );
            vm.set_naming(view.naming.is_some());
            vm.set_naming_text(view.naming.clone().unwrap_or_default().into());
            vm.set_kill_name(view.kill_prompt.clone().unwrap_or_default().into());
            vm.set_disconnected(matches!(view.capsule, Some(CapsuleView::Disconnected)));
            vm.set_send_capsule(match &view.capsule {
                Some(CapsuleView::Send(s)) => s.as_str().into(),
                _ => "".into(),
            });
            vm.set_has_progress(view.progress.is_some());
            vm.set_progress(
                view.progress
                    .as_ref()
                    .map(|p| p.percent as f32 / 100.0)
                    .unwrap_or(0.0),
            );
            vm.set_progress_state(
                view.progress
                    .as_ref()
                    .map(|p| progress_index(&p.state))
                    .unwrap_or(0),
            );
            w.set_window_title(view.title.as_str().into());
        });
    }

    fn render(&self, job: FrameJob) {
        crate::terminal::frame::submit(job);
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
pub struct RecordingUi {
    pub effects: std::sync::Arc<std::sync::Mutex<Vec<UiEffect>>>,
    pub views: std::sync::Arc<std::sync::Mutex<Vec<TerminalView>>>,
    pub frames: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

#[cfg(test)]
impl UiPort for RecordingUi {
    fn apply(&self, fx: UiEffect) {
        self.effects.lock().unwrap().push(fx);
    }
    fn view(&self, view: TerminalView) {
        self.views.lock().unwrap().push(view);
    }
    fn render(&self, _job: FrameJob) {
        self.frames
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
impl RecordingUi {
    pub fn last_view(&self) -> TerminalView {
        self.views.lock().unwrap().last().cloned().expect("a view")
    }
}

#[cfg(test)]
mod mapping_tests {
    use super::*;
    use crate::terminal::model::TabView;
    use crate::terminal::status::Lamp;
    use tether_core::osc::{Progress, ProgressState};

    #[test]
    fn lamp_indices_match_the_slint_order() {
        assert_eq!(lamp_index(Lamp::Warning), 0);
        assert_eq!(lamp_index(Lamp::Success), 1);
        assert_eq!(lamp_index(Lamp::Danger), 2);
    }

    #[test]
    fn tabs_map_with_progress_and_attention() {
        let tab = TabView {
            name: "build".into(),
            cwd_leaf: Some("api".into()),
            active: false,
            attention: true,
            progress: Some(Progress {
                state: ProgressState::Error,
                percent: 40,
            }),
        };
        let items = tab_items_from(&[tab]);
        assert_eq!(items[0].name, "build");
        assert_eq!(items[0].cwd, "api");
        assert!(items[0].attention);
        assert!(items[0].has_progress);
        assert!((items[0].progress - 0.4).abs() < 1e-6);
        assert_eq!(items[0].progress_state, 1);
    }

    #[test]
    fn style_from_prefs_falls_back_and_clamps() {
        let s =
            crate::terminal::geometry::TermStyle::from_prefs(&tether_core::prefs::TerminalPrefs {
                scheme: "no-such-theme".into(),
                font: "menlo".into(),
                size_pt: 99.0,
                ..Default::default()
            });
        assert_eq!(s.theme.id, "tether");
        assert_eq!(s.font.id, "cascadia-mono");
        assert_eq!(s.size_pt, 24.0);
    }
}
