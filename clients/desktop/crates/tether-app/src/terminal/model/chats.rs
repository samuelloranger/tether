//! The terminal model's side of the chats: routing, and turning what they ask for into effects.

use std::time::Duration;

use tether_core::acp::defaults::ChatDefaults;
use tether_core::acp::files::ChatFiles;
use tether_core::acp::options::OptionsCache;
use tether_core::osc::Notification;
use tether_core::throttle::ToastDecision;

use super::chat::{ChatMsg, Chats, Out};
use super::{Effect, TerminalModel, UiEffect};
use crate::terminal::status::ConnStatus;

impl TerminalModel {
    pub fn set_chat_files(&mut self, files: ChatFiles) {
        self.chats = Chats::new(Some(files), &self.machine.host);
    }

    pub fn set_chat_defaults(&mut self, defaults: ChatDefaults) {
        self.chats.set_defaults(defaults);
    }

    /// `scope` is `host:port`, the key the options cache is stored under.
    pub fn set_chat_options(&mut self, cache: OptionsCache, scope: &str, last_agent: &str) {
        self.chats.set_options_cache(cache, scope, last_agent);
    }

    pub(crate) fn chat_active(&self) -> bool {
        self.chats.active().is_some()
    }

    pub(crate) fn on_chat(&mut self, msg: ChatMsg, now: Duration, fx: &mut Vec<Effect>) {
        let mut out = Out::default();
        match msg {
            ChatMsg::NewChat(mode) => {
                let folder = self
                    .active_name()
                    .and_then(|n| self.session_cwds.get(n))
                    .filter(|c| !c.is_empty())
                    .cloned()
                    .unwrap_or_else(|| "~".to_string());
                self.chats.open_new_chat(mode, folder, now, &mut out);
            }
            other => self.chats.handle(other, now, &mut out),
        }
        self.chat_out(out, now, fx);
    }

    /// A session tab in front: the chat goes to the background.
    pub(crate) fn chat_leave(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if !self.chat_active() {
            return;
        }
        let mut out = Out::default();
        self.chats.leave_active(now, &mut out);
        self.chat_out(out, now, fx);
    }

    pub(crate) fn chat_select(&mut self, name: &str, now: Duration, fx: &mut Vec<Effect>) {
        let mut out = Out::default();
        self.chats.select(name, now, &mut out);
        self.chat_out(out, now, fx);
        fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
    }

    pub(crate) fn chats_connected(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        let mut out = Out::default();
        self.chats.on_connected(now, &mut out);
        self.chat_out(out, now, fx);
    }

    pub(crate) fn chats_dropped(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        let mut out = Out::default();
        self.chats.on_dropped(now, &mut out);
        self.chat_out(out, now, fx);
    }

    pub(crate) fn chats_tick(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if self.status != ConnStatus::Connected {
            return;
        }
        let mut out = Out::default();
        self.chats.usage_visible = self.sidebar.visibility() != tether_core::sidebar::Shown::Hidden;
        self.chats.on_tick(now, &mut out);
        self.chats.flush_due(now);
        self.chat_out(out, now, fx);
    }

    pub(crate) fn chats_focus(&mut self, focused: bool, now: Duration, fx: &mut Vec<Effect>) {
        let mut out = Out::default();
        self.chats.on_focus(focused, now, &mut out);
        self.chat_out(out, now, fx);
    }

    fn chat_out(&mut self, out: Out, now: Duration, fx: &mut Vec<Effect>) {
        for job in out.jobs {
            fx.push(Effect::Chat(job));
        }
        for (agent, id, value) in out.remembered {
            self.chats.remember(&agent, &id, &value);
            fx.push(Effect::Ui(UiEffect::RememberChatOption {
                agent,
                id,
                value,
            }));
        }
        for (agent, options) in out.options_seen {
            if self.chats.cache_options(&agent, &options) {
                fx.push(Effect::Ui(UiEffect::CacheChatOptions {
                    scope: self.chats.scope().to_string(),
                    agent,
                    options,
                }));
            }
        }
        if let Some(agent) = out.picked_agent {
            fx.push(Effect::Ui(UiEffect::RememberChatAgent(agent)));
        }
        if let Some(url) = out.open_url {
            fx.push(Effect::Ui(UiEffect::OpenUrl(url)));
        }
        if let Some(text) = out.clipboard {
            fx.push(Effect::Ui(UiEffect::SetClipboard(text)));
        }
        if let Some(chat) = out.pick_files {
            fx.push(Effect::Ui(UiEffect::PickChatFiles { chat }));
        }
        if out.show_terminal {
            fx.push(Effect::Ui(UiEffect::SetTitle(self.window_title())));
            fx.push(Effect::Redraw);
        }
        for (name, title, body) in out.toasts {
            let n = Notification {
                title: Some(title.clone()),
                body,
            };
            if let ToastDecision::Show(n) = self.toasts.offer(&name, n, now) {
                fx.push(Effect::Ui(UiEffect::Toast {
                    machine: self.machine.id.to_string(),
                    session: name,
                    title: format!("{} · {}", self.machine.name, title),
                    body: n.body,
                }));
                if !self.focused {
                    fx.push(Effect::Ui(UiEffect::FlashTaskbar));
                }
            }
        }
    }

    /// The pane follows the model after every message; streaming output is held to the frame rate.
    pub(crate) fn chat_sync(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        let mut out = Out::default();
        if let Some(screen) = self.chats.screen(now, &mut out) {
            fx.push(Effect::Ui(UiEffect::Chat(Box::new(screen))));
        }
        self.chat_out(out, now, fx);
    }
}
