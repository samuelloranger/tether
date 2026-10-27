use std::path::PathBuf;

use super::chat::ChatMsg;
use super::*;
use tether_core::upload::{ATTACHABLE_EXTENSIONS, PendingFile, SendQueue};

/// A chat attaches these itself; any other file is sent to the host.
pub(crate) fn is_attachable(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ATTACHABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

#[derive(Debug, Clone, PartialEq)]
pub enum SendSource {
    Path(PathBuf),
    Bytes { name: String, data: Vec<u8> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SendJob {
    pub sources: Vec<SendSource>,
    pub fallback_dir: Option<String>,
}

pub(crate) struct SendState {
    /// The tab or chat that was active when the send began. Every path goes there.
    pub target: String,
    /// The target is a chat: paths go into its draft, not a PTY.
    pub chat: bool,
    pub queue: Option<SendQueue>,
    pub pending_paste: Option<Vec<u8>>,
}

impl TerminalModel {
    pub(crate) fn start_send(&mut self, sources: Vec<SendSource>, fx: &mut Vec<Effect>) {
        let busy = self
            .send
            .as_ref()
            .is_some_and(|s| s.queue.as_ref().is_none_or(|q| !q.is_finished()));
        if sources.is_empty() || busy {
            return;
        }
        let chat = self.chats.active().map(str::to_string);
        let Some(target) = chat
            .clone()
            .or_else(|| self.active_name().map(str::to_string))
        else {
            return;
        };
        // A chat's folder is usually a repository: its files go to the uploads folder only.
        let fallback_dir = if chat.is_some() {
            None
        } else {
            self.session_cwds
                .get(&target)
                .filter(|d| d.starts_with('/'))
                .cloned()
                .or_else(|| {
                    self.tabs
                        .get(&target)
                        .and_then(|t| t.term.reports().cwd.clone())
                })
        };
        self.capsule_shown = None;
        self.send = Some(SendState {
            chat: chat.is_some(),
            target,
            queue: None,
            pending_paste: None,
        });
        fx.push(Effect::StartSend(SendJob {
            sources,
            fallback_dir,
        }));
    }

    pub(crate) fn on_send_files(&mut self, paths: Vec<PathBuf>, fx: &mut Vec<Effect>) {
        self.start_send(paths.into_iter().map(SendSource::Path).collect(), fx);
    }

    pub(crate) fn on_send_started(&mut self, names: Vec<String>) {
        let Some(state) = self.send.as_mut() else {
            return;
        };
        let files = names
            .into_iter()
            .map(|name| PendingFile {
                local: PathBuf::new(),
                name,
            })
            .collect();
        state.queue = Some(SendQueue::new(files, state.target.clone()));
    }

    pub(crate) fn on_send_file_started(&mut self, _index: usize) {}

    pub(crate) fn on_send_file_done(&mut self, remote: &str, now: Duration, fx: &mut Vec<Effect>) {
        let Some(state) = self.send.as_mut() else {
            return;
        };
        let target = state.target.clone();
        if state.chat {
            let finished = state.queue.as_mut().is_some_and(|q| {
                q.on_sent(remote, false);
                q.is_finished()
            });
            self.on_chat(
                ChatMsg::InsertText {
                    name: target,
                    text: format!("{remote} "),
                },
                now,
                fx,
            );
            if finished {
                self.capsule_shown = Some(now);
            }
            return;
        }
        let bracketed = self
            .tabs
            .get(&target)
            .is_some_and(|t| t.term.bracketed_paste());
        let Some(queue) = state.queue.as_mut() else {
            return;
        };
        let bytes = queue.on_sent(remote, bracketed);
        let finished = queue.is_finished();
        if self.is_live(&target) {
            fx.push(Effect::Write {
                name: target,
                bytes,
            });
        } else if let Some(state) = self.send.as_mut() {
            state
                .pending_paste
                .get_or_insert_with(Vec::new)
                .extend(bytes);
        }
        if finished {
            self.capsule_shown = Some(now);
        }
    }

    pub(crate) fn on_send_file_failed(&mut self, reason: String, now: Duration) {
        let Some(queue) = self.send.as_mut().and_then(|s| s.queue.as_mut()) else {
            return;
        };
        queue.on_failed(&reason);
        self.capsule_shown = Some(now);
    }

    pub(crate) fn send_capsule(&self) -> Option<String> {
        self.send.as_ref()?.queue.as_ref()?.capsule()
    }
}

#[cfg(test)]
mod tests {
    use super::super::chat::ChatMsg;
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::model::CapsuleView;
    use crate::terminal::testkit::session;
    use std::path::PathBuf;

    const UP: &str = "/home/sam/.tether/uploads";

    fn writes(fx: &[Effect]) -> Vec<(String, Vec<u8>)> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Write { name, bytes } => Some((name.clone(), bytes.clone())),
                _ => None,
            })
            .collect()
    }

    fn sending(names: &[&str]) -> TerminalModel {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::SelectTab("a".into()), t(1));
        m.handle(Msg::Attached { name: "a".into() }, t(1));
        m.handle(Msg::Attached { name: "b".into() }, t(1));
        let fx = m.handle(
            Msg::SendFiles(names.iter().map(PathBuf::from).collect()),
            t(2),
        );
        assert!(fx.iter().any(|e| matches!(e, Effect::StartSend(_))));
        m.handle(
            Msg::SendStarted {
                names: names.iter().map(|s| s.to_string()).collect(),
            },
            t(3),
        );
        m
    }

    #[test]
    fn each_file_is_its_own_paste_with_a_space_before_all_but_the_first() {
        let mut m = sending(&["a.png", "b.png"]);
        assert_eq!(
            m.view().capsule,
            Some(CapsuleView::Send("Sending a.png (1/2)".into()))
        );
        let fx = m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/a.png"),
            },
            t(10),
        );
        assert_eq!(
            writes(&fx),
            vec![("a".into(), format!("'{UP}/a.png'").into_bytes())]
        );
        assert_eq!(
            m.view().capsule,
            Some(CapsuleView::Send("Sending b.png (2/2)".into()))
        );
        let fx = m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/b.png"),
            },
            t(20),
        );
        assert_eq!(
            writes(&fx),
            vec![("a".into(), format!(" '{UP}/b.png'").into_bytes())]
        );
        assert_eq!(
            m.view().capsule,
            Some(CapsuleView::Send("Sent ~/.tether/uploads/b.png".into()))
        );
    }

    #[test]
    fn pastes_are_bracketed_when_the_program_asked() {
        let mut m = sending(&["a.png"]);
        m.handle(
            Msg::PtyData {
                name: "a".into(),
                bytes: b"\x1b[?2004h".to_vec(),
            },
            t(5),
        );
        let fx = m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/a.png"),
            },
            t(10),
        );
        assert_eq!(
            writes(&fx)[0].1,
            format!("\x1b[200~'{UP}/a.png'\x1b[201~").into_bytes()
        );
    }

    #[test]
    fn pastes_go_to_the_tab_active_when_the_send_began() {
        let mut m = sending(&["a.png"]);
        m.handle(Msg::SelectTab("b".into()), t(5));
        let fx = m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/a.png"),
            },
            t(10),
        );
        assert_eq!(writes(&fx)[0].0, "a");
    }

    #[test]
    fn a_failure_names_the_file_and_keeps_earlier_pastes() {
        let mut m = sending(&["a.png", "b.png"]);
        m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/a.png"),
            },
            t(10),
        );
        let fx = m.handle(
            Msg::SendFileFailed {
                reason: "Could not connect: reset".into(),
            },
            t(20),
        );
        assert!(writes(&fx).is_empty());
        assert_eq!(
            m.view().capsule,
            Some(CapsuleView::Send(
                "Couldn't send b.png: Could not connect: reset".into()
            ))
        );
    }

    fn chat_in_front() -> (TerminalModel, tempfile::TempDir) {
        let (mut m, dir) = super::super::tests::live_with_chats(
            vec![session("a", 1)],
            super::super::tests::ONE_CHAT,
        );
        m.handle(Msg::Chat(ChatMsg::Select("chat-c".into())), t(10));
        (m, dir)
    }

    #[test]
    fn a_chat_send_splits_images_from_other_files() {
        let (mut m, _dir) = chat_in_front();
        let fx = m.handle(
            Msg::SendFiles(vec![PathBuf::from("a.PNG"), PathBuf::from("notes.pdf")]),
            t(11),
        );
        let sends: Vec<&SendJob> = fx
            .iter()
            .filter_map(|e| match e {
                Effect::StartSend(job) => Some(job),
                _ => None,
            })
            .collect();
        assert_eq!(sends.len(), 1, "{fx:?}");
        assert_eq!(sends[0].sources, [SendSource::Path("notes.pdf".into())]);
        assert_eq!(sends[0].fallback_dir, None);
        assert!(
            fx.iter()
                .any(|e| matches!(e, Effect::Chat(super::super::chat::ChatJob::Encode { .. })))
        );
    }

    #[test]
    fn a_path_lands_in_the_chat_that_started_the_send() {
        let (mut m, _dir) = chat_in_front();
        m.handle(Msg::SendFiles(vec![PathBuf::from("notes.pdf")]), t(11));
        m.handle(
            Msg::SendStarted {
                names: vec!["notes.pdf".into()],
            },
            t(12),
        );
        m.handle(Msg::SelectTab("a".into()), t(13));
        let fx = m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/notes.pdf"),
            },
            t(14),
        );
        assert!(
            !fx.iter().any(|e| matches!(e, Effect::Write { .. })),
            "{fx:?}"
        );
        let want = format!("{UP}/notes.pdf ");
        assert_eq!(
            m.chats.draft_of("chat-c"),
            Some((want.clone(), want.chars().count()))
        );
    }

    #[test]
    fn inserting_text_puts_it_at_the_caret() {
        let (mut m, _dir) = chat_in_front();
        m.handle(
            Msg::Chat(ChatMsg::DraftEdited {
                text: "read  please".into(),
                cursor_byte: 5,
            }),
            t(11),
        );
        m.handle(
            Msg::Chat(ChatMsg::InsertText {
                name: "chat-c".into(),
                text: "/x".into(),
            }),
            t(12),
        );
        assert_eq!(
            m.chats.draft_of("chat-c"),
            Some(("read /x please".into(), 7))
        );
    }

    #[test]
    fn the_capsule_leaves_after_four_seconds_or_on_a_keystroke() {
        let mut m = sending(&["a.png"]);
        m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/a.png"),
            },
            t(1_000),
        );
        m.handle(Msg::Tick, t(4_900));
        assert!(m.view().capsule.is_some());
        m.handle(Msg::Tick, t(5_100));
        assert_eq!(m.view().capsule, None);

        let mut m = sending(&["a.png"]);
        m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/a.png"),
            },
            t(1_000),
        );
        let key = tether_core::keymap::KeyInput::Char {
            unmodified: 'x',
            produced: Some("x".into()),
            digit: None,
        };
        m.handle(
            Msg::Key {
                input: key,
                mods: Default::default(),
            },
            t(1_100),
        );
        assert_eq!(m.view().capsule, None);
    }

    #[test]
    fn a_keystroke_does_not_hide_an_in_flight_capsule() {
        let mut m = sending(&["a.png", "b.png"]);
        let key = tether_core::keymap::KeyInput::Char {
            unmodified: 'x',
            produced: Some("x".into()),
            digit: None,
        };
        m.handle(
            Msg::Key {
                input: key,
                mods: Default::default(),
            },
            t(10),
        );
        assert_eq!(
            m.view().capsule,
            Some(CapsuleView::Send("Sending a.png (1/2)".into()))
        );
    }

    #[test]
    fn a_second_send_while_one_runs_is_ignored() {
        let mut m = sending(&["a.png"]);
        assert!(
            !m.handle(Msg::SendFiles(vec![PathBuf::from("c.png")]), t(10))
                .iter()
                .any(|e| matches!(e, Effect::StartSend(_)))
        );
    }

    #[test]
    fn drop_mid_send_stops_queue_and_keeps_target() {
        let mut m = sending(&["a.png", "b.png"]);
        assert_eq!(
            writes(&m.handle(
                Msg::SendFileDone {
                    remote: format!("{UP}/a.png"),
                },
                t(10)
            ))[0]
                .0,
            "a"
        );
        m.handle(Msg::Dropped, t(20));
        let fx = m.handle(
            Msg::SendFileFailed {
                reason: "Could not connect: broken pipe".into(),
            },
            t(30),
        );
        assert!(writes(&fx).is_empty());
        assert_eq!(
            m.view().capsule,
            Some(CapsuleView::Send(
                "Couldn't send b.png: Could not connect: broken pipe".into()
            ))
        );
        let fx = m.handle(Msg::Opened, t(1_200));
        assert!(writes(&fx).is_empty());
        let fx = m.handle(
            Msg::Key {
                input: tether_core::keymap::KeyInput::Char {
                    unmodified: 'x',
                    produced: Some("x".into()),
                    digit: None,
                },
                mods: Default::default(),
            },
            t(1_210),
        );
        assert!(
            writes(&fx).is_empty(),
            "input stays dropped until the channel is live again"
        );
    }

    #[test]
    fn a_paste_waits_until_its_tab_is_live() {
        let mut m = sending(&["a.png"]);
        m.channels
            .insert("a".into(), super::super::Chan::Opening(1));
        let fx = m.handle(
            Msg::SendFileDone {
                remote: format!("{UP}/a.png"),
            },
            t(10),
        );
        assert!(writes(&fx).is_empty());
        let fx = m.handle(Msg::Attached { name: "a".into() }, t(11));
        assert_eq!(
            writes(&fx),
            vec![("a".into(), format!("'{UP}/a.png'").into_bytes())]
        );
    }

    #[test]
    fn uploads_finishing_while_not_live_are_all_pasted_once_in_order() {
        let mut m = sending(&["a.png", "b.png", "c.png"]);
        m.channels
            .insert("a".into(), super::super::Chan::Opening(1));
        for (i, n) in ["a.png", "b.png", "c.png"].iter().enumerate() {
            let fx = m.handle(
                Msg::SendFileDone {
                    remote: format!("{UP}/{n}"),
                },
                t(10 + i as u64),
            );
            assert!(writes(&fx).is_empty());
        }
        let fx = m.handle(Msg::Attached { name: "a".into() }, t(20));
        assert_eq!(
            writes(&fx),
            vec![(
                "a".into(),
                format!("'{UP}/a.png' '{UP}/b.png' '{UP}/c.png'").into_bytes()
            )]
        );
    }
}
