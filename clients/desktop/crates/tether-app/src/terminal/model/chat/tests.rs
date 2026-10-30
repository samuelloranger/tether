use std::time::Duration;

use tether_core::acp::defaults::ChatDefaults;
use tether_core::acp::files::ChatFiles;
use tether_core::connect::ConnectError;

use super::view::{ChatScreen, RowBody};
use super::*;

fn t(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

struct Harness {
    chats: Chats,
    _dir: tempfile::TempDir,
    files: ChatFiles,
    now: u64,
    jobs: Vec<ChatJob>,
    toasts: Vec<(String, String, String)>,
    remembered: Vec<(String, String)>,
    seen: Vec<(String, Vec<tether_core::acp::message::ConfigOption>)>,
}

const CHECK_OK: &str = "tether=found\nversion={\"name\":\"tether\",\"protocol\":1}\nnode=ok\n";

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let files = ChatFiles::new(dir.path().to_path_buf(), "devbox.local:22");
        let mut h = Self {
            chats: Chats::new(
                Some(ChatFiles::new(dir.path().to_path_buf(), "devbox.local:22")),
                "devbox.local",
            ),
            _dir: dir,
            files,
            now: 0,
            jobs: Vec::new(),
            toasts: Vec::new(),
            remembered: Vec::new(),
            seen: Vec::new(),
        };
        h.run(|c, now, out| c.on_connected(now, out));
        h.run(|c, now, out| c.on_tick(now, out));
        h
    }

    fn run(&mut self, f: impl FnOnce(&mut Chats, Duration, &mut Out)) {
        self.now += 10;
        let mut out = Out::default();
        f(&mut self.chats, t(self.now), &mut out);
        self.jobs.extend(out.jobs);
        self.toasts.extend(out.toasts);
        self.seen.extend(out.options_seen);
        self.remembered
            .extend(out.remembered.into_iter().map(|(_, id, value)| (id, value)));
    }

    fn msg(&mut self, m: ChatMsg) {
        self.run(|c, now, out| c.handle(m, now, out));
    }

    fn take(&mut self) -> Vec<ChatJob> {
        std::mem::take(&mut self.jobs)
    }

    fn screen(&mut self) -> ChatScreen {
        let mut out = Out::default();
        self.chats.dirty = true;
        let s = self.chats.screen(t(self.now), &mut out);
        self.jobs.extend(out.jobs);
        s.or_else(|| self.chats.last_screen.clone()).unwrap()
    }

    fn exec(&mut self, pred: impl Fn(&ExecTag) -> bool, output: &str) {
        let tag = self
            .take()
            .into_iter()
            .find_map(|j| match j {
                ChatJob::Exec { tag, .. } if pred(&tag) => Some(tag),
                _ => None,
            })
            .expect("an exec for that");
        self.msg(ChatMsg::ExecDone {
            tag,
            result: Ok(output.to_string()),
        });
    }

    /// Opens a new chat in `~/proj` through the host checks and returns its name.
    fn new_chat(&mut self) -> String {
        self.run(|c, now, out| c.open_new_chat(0, "~/proj".into(), now, out));
        self.msg(ChatMsg::NewChatStart);
        self.exec(|t| matches!(t, ExecTag::NewChat { .. }), CHECK_OK);
        self.exec(|t| matches!(t, ExecTag::NewChat { .. }), "/home/sam");
        self.chats.active().unwrap().to_string()
    }

    fn dial_of(&self, jobs: &[ChatJob]) -> Option<(String, u64, String)> {
        jobs.iter().find_map(|j| match j {
            ChatJob::Dial {
                name,
                generation,
                command,
            } => Some((name.clone(), *generation, command.clone())),
            _ => None,
        })
    }

    /// Answers the dial and the host's recorded answers; returns what was written.
    fn open_stream(&mut self) -> (String, u64, Vec<String>) {
        let jobs = self.take();
        let (name, generation, _) = self.dial_of(&jobs).expect("a dial");
        self.jobs = jobs;
        self.msg(ChatMsg::Dialed {
            name: name.clone(),
            generation,
            result: Ok(()),
        });
        self.exec(|t| matches!(t, ExecTag::Answers { .. }), "{}");
        (name, generation, self.writes())
    }

    fn writes(&mut self) -> Vec<String> {
        let jobs = self.take();
        let mut out = Vec::new();
        for j in jobs {
            match j {
                ChatJob::Write { bytes, .. } => out.push(String::from_utf8(bytes).unwrap()),
                other => self.jobs.push(other),
            }
        }
        out
    }

    fn feed(&mut self, name: &str, generation: u64, line: &str) {
        self.msg(ChatMsg::Data {
            name: name.into(),
            generation,
            bytes: format!("{line}\n").into_bytes(),
        });
    }

    /// The replay window passes with nothing new: the link goes live.
    fn settle(&mut self) {
        self.now += 500;
        self.run(|c, now, out| c.on_tick(now, out));
    }

    /// A fresh chat through initialize and session/new, live.
    fn live_chat(&mut self) -> (String, u64) {
        let name = self.new_chat();
        let (name2, generation, writes) = self.open_stream();
        assert_eq!(name, name2);
        assert!(
            writes[0].contains("\"method\":\"initialize\""),
            "{writes:?}"
        );
        self.feed(
            &name,
            generation,
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
        );
        let writes = self.writes();
        assert!(
            writes[0].contains("\"method\":\"session/new\""),
            "{writes:?}"
        );
        assert!(writes[0].contains("/home/sam/proj"), "{writes:?}");
        self.feed(
            &name,
            generation,
            r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}"#,
        );
        self.settle();
        (name, generation)
    }
}

fn rows(s: &ChatScreen) -> Vec<&RowBody> {
    s.rows.iter().map(|r| &r.body).collect()
}

#[test]
fn connecting_reads_the_hosts_chat_status() {
    let mut h = Harness::new();
    let jobs = h.take();
    assert!(jobs.iter().any(|j| matches!(
        j,
        ChatJob::Exec { tag: ExecTag::Status, command } if command.ends_with("acp status 2>&1 || true")
    )));
}

#[test]
fn a_host_without_status_falls_back_to_ls() {
    let mut h = Harness::new();
    h.exec(
        |t| *t == ExecTag::Status,
        "tether: unknown acp command \"status\"\n",
    );
    assert!(h.take().iter().any(|j| matches!(
        j,
        ChatJob::Exec {
            tag: ExecTag::List,
            ..
        }
    )));
}

#[test]
fn listed_chats_become_tabs_oldest_first_with_their_state() {
    let mut h = Harness::new();
    h.exec(
        |t| *t == ExecTag::Status,
        concat!(
            r#"{"name":"chat-b","state":"running","logBytes":10,"cwd":"/home/sam/api","created":200,"turn":"waiting"}"#,
            "\n",
            r#"{"name":"chat-a","state":"running","logBytes":10,"cwd":"/home/sam/web","created":100,"turn":"working","title":"Fix the build"}"#,
            "\n"
        ),
    );
    let s = h.screen();
    let tabs: Vec<_> = s
        .tabs
        .iter()
        .map(|t| (t.title.as_str(), t.label.as_str()))
        .collect();
    assert_eq!(tabs, [("Fix the build", "working"), ("api", "needs you")]);
    assert!(
        h.toasts.is_empty(),
        "the first read after connecting is a baseline"
    );
}

#[test]
fn a_chat_that_starts_waiting_toasts_once() {
    let mut h = Harness::new();
    let line = |turn: &str| {
        format!(
            r#"{{"name":"chat-a","state":"running","logBytes":10,"cwd":"/home/sam/web","created":100,"turn":"{turn}"}}"#
        )
    };
    h.exec(|t| *t == ExecTag::Status, &line("working"));
    h.now += 6000;
    h.run(|c, now, out| c.on_tick(now, out));
    h.exec(|t| *t == ExecTag::Status, &line("waiting"));
    h.now += 6000;
    h.run(|c, now, out| c.on_tick(now, out));
    h.exec(|t| *t == ExecTag::Status, &line("waiting"));
    assert_eq!(h.toasts.len(), 1);
    assert_eq!(h.toasts[0].0, "chat-a");
    assert_eq!(h.toasts[0].1, "web");
}

#[test]
fn a_chat_started_elsewhere_opens_read_only_without_spawning() {
    let mut h = Harness::new();
    h.exec(
        |t| *t == ExecTag::Status,
        r#"{"name":"chat-a","state":"running","logBytes":10,"cwd":"/home/sam/web","created":100,"turn":"idle"}"#,
    );
    h.msg(ChatMsg::Select("chat-a".into()));
    let jobs = h.take();
    let (_, _, command) = h.dial_of(&jobs).unwrap();
    assert!(command.contains("attach 'chat-a' --from 0"), "{command}");
    assert!(!command.contains("--spawn"), "{command}");
    let s = h.screen();
    assert_eq!(s.composer.banner, "Started on another device. Read only.");
}

#[test]
fn a_missing_tool_on_the_host_stops_the_new_chat_with_the_reason() {
    let mut h = Harness::new();
    h.run(|c, now, out| c.open_new_chat(0, "~".into(), now, out));
    h.msg(ChatMsg::NewChatStart);
    h.exec(
        |t| matches!(t, ExecTag::NewChat { .. }),
        "tether=missing\nnode=missing\n",
    );
    let s = h.screen();
    let nc = s.new_chat.expect("the dialog stays");
    assert!(
        nc.error.contains("Install tether on devbox.local"),
        "{}",
        nc.error
    );
    assert!(nc.error.contains("Node.js is required"), "{}", nc.error);
    assert!(h.chats.active().is_none());
}

#[test]
fn a_new_chat_spawns_the_pinned_adapter_in_the_expanded_folder() {
    let mut h = Harness::new();
    let name = h.new_chat();
    let jobs = h.take();
    let (dialed, _, command) = h.dial_of(&jobs).unwrap();
    assert_eq!(dialed, name);
    assert!(
        command.contains("--spawn 'npx -y @agentclientprotocol/claude-agent-acp@0.95.0'"),
        "{command}"
    );
    assert!(command.contains("--cwd '/home/sam/proj'"), "{command}");
    let s = h.screen();
    assert!(s.active);
    assert_eq!(s.tabs.last().unwrap().name, name);
    assert!(s.new_chat.is_none());
}

#[test]
fn nothing_is_sent_until_the_replay_settles() {
    let mut h = Harness::new();
    let name = h.new_chat();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
    );
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}"#,
    );
    h.writes();
    h.msg(ChatMsg::DraftEdited {
        text: "hi".into(),
        cursor_byte: 2,
    });
    h.msg(ChatMsg::Send);
    assert!(h.writes().is_empty());
    h.settle();
    h.msg(ChatMsg::Send);
    let writes = h.writes();
    assert!(
        writes[0].contains("\"method\":\"session/prompt\""),
        "{writes:?}"
    );
}

#[test]
fn a_sent_message_and_the_agents_reply_show_in_the_transcript() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.msg(ChatMsg::DraftEdited {
        text: "Tidy the README".into(),
        cursor_byte: 15,
    });
    h.msg(ChatMsg::Send);
    let writes = h.writes();
    assert!(writes[0].contains("Tidy the README"));
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"Done. **Two** sections moved."}}}}"#,
    );
    let s = h.screen();
    let rows = rows(&s);
    assert!(matches!(rows[0], RowBody::User { text, .. } if text == "Tidy the README"));
    assert!(matches!(rows[1], RowBody::Markdown(md) if md.text == "Done. Two sections moved."));
    assert!(matches!(rows.last(), Some(RowBody::Working(_))));
    assert_eq!(s.composer.action_label, "Stop");
}

#[test]
fn a_prompt_that_never_reached_the_agent_waits_under_not_sent() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.msg(ChatMsg::DraftEdited {
        text: "lost".into(),
        cursor_byte: 4,
    });
    h.msg(ChatMsg::Send);
    let tag = h
        .take()
        .into_iter()
        .find_map(|j| match j {
            ChatJob::Write { tag: Some(tag), .. } => Some(tag),
            _ => None,
        })
        .unwrap();
    h.msg(ChatMsg::WriteFailed {
        name: name.clone(),
        generation,
        tag,
    });
    let s = h.screen();
    let rows = rows(&s);
    assert!(
        !rows.iter().any(|r| matches!(r, RowBody::User { .. })),
        "the transcript takes it back: {rows:?}"
    );
    assert!(
        matches!(rows.last(), Some(RowBody::NotSent { text, can_retry: true, .. }) if text == "lost")
    );
    assert_eq!(h.files.outbox(&name).len(), 1, "kept across a restart");
}

#[test]
fn a_permission_waits_in_its_card_and_approve_answers_it() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","title":"Edit README.md","kind":"edit","content":[{"type":"diff","path":"/home/sam/proj/README.md","oldText":"a\n","newText":"b\n"}]},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}"#,
    );
    let s = h.screen();
    let card = s.permission.expect("a permission card");
    assert_eq!(card.path, "README.md");
    assert_eq!((card.added, card.removed), (1, 1));
    assert_eq!(card.primary.as_ref().unwrap().0, "allow");
    assert_eq!(card.reject.as_ref().unwrap().0, "reject");
    assert_eq!(s.composer.placeholder, "Answer the permission above");
    h.msg(ChatMsg::Approve("allow".into()));
    let writes = h.writes();
    assert!(writes[0].contains("\"optionId\":\"allow\""), "{writes:?}");
    assert!(writes[0].contains("\"id\":\"p1\""), "{writes:?}");
    assert!(h.screen().permission.is_none());
}

#[test]
fn a_question_answers_with_one_click_on_a_single_choice() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":"q1","method":"elicitation/create","params":{"sessionId":"s1","message":"Which runner?","requestedSchema":{"type":"object","properties":{"runner":{"type":"string","title":"Runner","oneOf":[{"const":"vitest","title":"Vitest"},{"const":"jest","title":"Jest"}]}},"required":["runner"]}}}"#,
    );
    let s = h.screen();
    let q = s.question.expect("a question card");
    assert_eq!(q.message, "Which runner?");
    assert!(!q.show_submit, "one single-choice field submits on click");
    h.msg(ChatMsg::QuestionChoose {
        field: "runner".into(),
        value: "jest".into(),
    });
    let writes = h.writes();
    assert!(writes[0].contains("\"action\":\"accept\""), "{writes:?}");
    assert!(writes[0].contains("\"runner\":\"jest\""), "{writes:?}");
}

#[test]
fn stop_cancels_the_turn() {
    let mut h = Harness::new();
    let (_, _) = h.live_chat();
    h.msg(ChatMsg::DraftEdited {
        text: "go".into(),
        cursor_byte: 2,
    });
    h.msg(ChatMsg::Send);
    h.writes();
    h.msg(ChatMsg::Stop);
    let writes = h.writes();
    assert!(
        writes[0].contains("\"method\":\"session/cancel\""),
        "{writes:?}"
    );
}

#[test]
fn leaving_hangs_up_and_coming_back_resumes_from_the_snapshot() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.exec(
        |t| {
            matches!(
                t,
                ExecTag::Inspect {
                    why: InspectWhy::Learn,
                    ..
                }
            )
        },
        &format!("{name}\trunning\t4096\t/home/sam/proj\t300\tnpx\n"),
    );
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}"#,
    );
    h.run(|c, now, out| c.leave_active(now, out));
    assert!(
        h.take()
            .iter()
            .any(|j| matches!(j, ChatJob::Hangup { name: n } if *n == name))
    );
    let snapshot = h.files.snapshot(&name).expect("a snapshot on leaving");
    assert!(snapshot.offset > 0);
    h.msg(ChatMsg::Select(name.clone()));
    h.exec(
        |t| {
            matches!(
                t,
                ExecTag::Inspect {
                    why: InspectWhy::Resume,
                    ..
                }
            )
        },
        &format!("{name}\trunning\t4096\t/home/sam/proj\t300\tnpx\n"),
    );
    let jobs = h.take();
    let (_, _, command) = h.dial_of(&jobs).unwrap();
    assert!(
        command.contains(&format!("--from {}", snapshot.offset)),
        "{command}"
    );
    assert!(!command.contains("--spawn"));
    let s = h.screen();
    assert!(
        rows(&s)
            .iter()
            .any(|r| matches!(r, RowBody::Markdown(md) if md.text == "hello")),
        "the transcript stays on screen while it reconnects"
    );
}

#[test]
fn an_agent_that_stops_before_the_chat_starts_is_not_a_host_problem() {
    let mut h = Harness::new();
    let name = h.new_chat();
    let jobs = h.take();
    let (dialed, generation, _) = h.dial_of(&jobs).expect("a dial");
    assert_eq!(name, dialed);
    h.msg(ChatMsg::Closed { name, generation });
    assert_eq!(
        h.screen().notice,
        "The agent stopped before the chat started."
    );
}

#[test]
fn an_agent_that_exits_during_initialize_or_session_new_reads_stopped() {
    for answered_initialize in [false, true] {
        let mut h = Harness::new();
        let name = h.new_chat();
        let (_, generation, _) = h.open_stream();
        if answered_initialize {
            h.feed(
                &name,
                generation,
                r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
            );
            h.writes();
        }
        h.msg(ChatMsg::Closed {
            name: name.clone(),
            generation,
        });
        assert_eq!(
            h.screen().notice,
            "The agent stopped before the chat started."
        );
    }
}

#[test]
fn an_agent_error_reads_as_its_message_without_the_host_prefix() {
    let mut h = Harness::new();
    let name = h.new_chat();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"model unavailable"}}"#,
    );
    assert_eq!(h.screen().notice, "model unavailable");
    let mut h = Harness::new();
    let name = h.new_chat();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":""}}"#,
    );
    assert_eq!(
        h.screen().notice,
        "The agent reported an error (code -32603)."
    );
}

#[test]
fn a_stream_that_ends_on_an_ended_chat_reads_ended() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.msg(ChatMsg::Closed {
        name: name.clone(),
        generation,
    });
    h.exec(
        |t| {
            matches!(
                t,
                ExecTag::Inspect {
                    why: InspectWhy::Loss,
                    ..
                }
            )
        },
        &format!("{name}\tended\t4096\t/home/sam/proj\t300\tnpx\n"),
    );
    let s = h.screen();
    assert_eq!(s.header.phase_word, "Ended");
    assert_eq!(
        s.composer.banner,
        "This chat has ended. You can still read it."
    );
}

#[test]
fn a_dropped_stream_on_a_running_chat_offers_reconnect() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.msg(ChatMsg::Closed {
        name: name.clone(),
        generation,
    });
    h.exec(
        |t| {
            matches!(
                t,
                ExecTag::Inspect {
                    why: InspectWhy::Loss,
                    ..
                }
            )
        },
        &format!("{name}\trunning\t4096\t/home/sam/proj\t300\tnpx\n"),
    );
    assert_eq!(h.screen().header.phase, 3);
    h.msg(ChatMsg::Reconnect);
    assert!(h.take().iter().any(|j| matches!(
        j,
        ChatJob::Exec {
            tag: ExecTag::Answers { .. },
            ..
        }
    )));
}

#[test]
fn deleting_kills_on_the_host_and_forgets_the_chat_here() {
    let mut h = Harness::new();
    let (name, _) = h.live_chat();
    h.msg(ChatMsg::Delete(name.clone()));
    assert!(!h.screen().delete_title.is_empty());
    h.msg(ChatMsg::DeleteConfirmed);
    let jobs = h.take();
    assert!(jobs.iter().any(|j| matches!(
        j,
        ChatJob::Exec { tag: ExecTag::Kill { .. }, command } if command.ends_with(&format!("acp kill '{name}'"))
    )));
    let s = h.screen();
    assert!(!s.active);
    assert!(s.tabs.iter().all(|t| t.name != name));
    assert!(h.files.journal(&name).session_id.is_none());
}

#[test]
fn escape_closes_the_topmost_overlay_first() {
    let mut h = Harness::new();
    let _ = h.live_chat();
    h.msg(ChatMsg::Controls);
    h.msg(ChatMsg::OpenImage("abc".into()));
    h.msg(ChatMsg::Escape);
    let s = h.screen();
    assert!(s.viewer.is_none());
    assert!(s.controls.is_some());
    h.msg(ChatMsg::Escape);
    assert!(h.screen().controls.is_none());
}

#[test]
fn a_slash_draft_offers_the_agents_commands() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"compact","description":"Summarise"},{"name":"review","description":"Review a PR","input":{"hint":"number"}}]}}}"#,
    );
    h.msg(ChatMsg::DraftEdited {
        text: "/re".into(),
        cursor_byte: 3,
    });
    let s = h.screen();
    let (kind, rows) = s.composer.palette.clone().expect("a palette");
    assert_eq!(kind, view::PaletteKind::Slash);
    assert_eq!(rows[0].0, "/review");
    h.msg(ChatMsg::PalettePick(0));
    assert_eq!(h.screen().draft.as_deref(), Some("/review "));
}

#[test]
fn an_attached_image_waits_for_its_encoding_before_send() {
    let mut h = Harness::new();
    let (name, _) = h.live_chat();
    h.msg(ChatMsg::AttachBytes(vec![1, 2, 3]));
    let key = h
        .take()
        .into_iter()
        .find_map(|j| match j {
            ChatJob::Encode { key, .. } => Some(key),
            _ => None,
        })
        .unwrap();
    assert!(!h.screen().composer.action_enabled);
    h.msg(ChatMsg::Encoded {
        name,
        key,
        result: Err("That file isn't an image.".into()),
    });
    let s = h.screen();
    assert_eq!(s.composer.attach_error, "That file isn't an image.");
    assert!(s.composer.attachments.is_empty());
}

#[test]
fn an_exec_failure_never_breaks_the_list() {
    let mut h = Harness::new();
    let tag = ExecTag::Status;
    h.take();
    h.msg(ChatMsg::ExecDone {
        tag,
        result: Err(ConnectError::Timeout),
    });
    assert!(h.screen().tabs.is_empty());
}

#[test]
fn a_new_chat_asked_from_home_waits_for_the_machine() {
    use crate::terminal::model::{Msg, TerminalModel};
    use crate::terminal::testkit::*;
    let (mut m, _) = TerminalModel::new(
        machine(),
        crate::terminal::geometry::TermStyle::default(),
        grid(),
    );
    m.handle(Msg::Chat(ChatMsg::NewChatWhenReady), t(0));
    m.handle(Msg::Opened, t(1));
    let fx = m.handle(
        Msg::Ls {
            id: 1,
            result: Ok(vec![session("default", 1)]),
        },
        t(2),
    );
    let screen = fx.iter().find_map(|e| match e {
        crate::terminal::model::Effect::Ui(crate::terminal::model::UiEffect::Chat(s)) => {
            Some(s.clone())
        }
        _ => None,
    });
    assert!(screen.expect("a chat screen").new_chat.is_some());
}

#[test]
fn a_signed_out_agent_offers_another_try_after_signing_in() {
    let mut h = Harness::new();
    let name = h.new_chat();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
    );
    h.writes();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}"#,
    );
    h.settle();
    let s = h.screen();
    assert!(matches!(
        rows(&s).last(),
        Some(RowBody::SignedOut { retry: Some(0), message }) if message.contains("isn't signed in on devbox.local")
    ));
    assert!(!s.composer.can_send);
    h.msg(ChatMsg::SignInRetry);
    let writes = h.writes();
    assert!(
        writes[0].contains("\"method\":\"initialize\""),
        "{writes:?}"
    );
    assert!(matches!(
        rows(&h.screen()).last(),
        Some(RowBody::SignedOut { retry: Some(1), .. })
    ));
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":3,"result":{"protocolVersion":1}}"#,
    );
    h.writes();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"Authentication required"}}"#,
    );
    assert!(matches!(
        rows(&h.screen()).last(),
        Some(RowBody::SignedOut { retry: Some(2), .. })
    ));
}

#[test]
fn a_long_transcript_lays_out_its_end_and_earlier_messages_grows_it() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    for n in 0..80 {
        h.feed(
            &name,
            generation,
            &format!(
                r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","messageId":"m{n}","content":{{"type":"text","text":"reply {n}"}}}}}}}}"#
            ),
        );
    }
    let s = h.screen();
    assert!(matches!(rows(&s)[0], RowBody::Earlier));
    let shown = rows(&s)
        .iter()
        .filter(|r| matches!(r, RowBody::Markdown(_)))
        .count();
    assert_eq!(shown, 60);
    h.msg(ChatMsg::Earlier);
    let s = h.screen();
    assert!(!matches!(rows(&s)[0], RowBody::Earlier));
    assert!(matches!(rows(&s)[0], RowBody::Markdown(md) if md.text == "reply 0"));
}

#[test]
fn scrolled_up_the_window_holds_its_start_and_back_at_the_end_it_follows_again() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    let reply = |n: usize| {
        format!(
            r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","messageId":"m{n}","content":{{"type":"text","text":"reply {n}"}}}}}}}}"#
        )
    };
    for n in 0..70 {
        h.feed(&name, generation, &reply(n));
    }
    let first = |s: &ChatScreen| {
        s.rows
            .iter()
            .find_map(|r| match &r.body {
                RowBody::Markdown(md) => Some(md.text.clone()),
                _ => None,
            })
            .unwrap()
    };
    let before = first(&h.screen());
    h.msg(ChatMsg::Following(false));
    for n in 70..75 {
        h.feed(&name, generation, &reply(n));
    }
    assert_eq!(
        first(&h.screen()),
        before,
        "rows stay put while the reader is up there"
    );
    h.msg(ChatMsg::Following(true));
    assert_ne!(first(&h.screen()), before);
}

fn fail_last_write(h: &mut Harness, name: &str, generation: u64) {
    let tag = h
        .take()
        .into_iter()
        .rev()
        .find_map(|j| match j {
            ChatJob::Write { tag: Some(tag), .. } => Some(tag),
            _ => None,
        })
        .unwrap();
    h.msg(ChatMsg::WriteFailed {
        name: name.into(),
        generation,
        tag,
    });
}

#[test]
fn a_retried_message_that_lands_leaves_the_stored_outbox() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.msg(ChatMsg::DraftEdited {
        text: "lost".into(),
        cursor_byte: 4,
    });
    h.msg(ChatMsg::Send);
    fail_last_write(&mut h, &name, generation);
    assert_eq!(h.files.outbox(&name).len(), 1);
    let key = h
        .screen()
        .rows
        .iter()
        .find(|r| matches!(r.body, RowBody::NotSent { .. }))
        .unwrap()
        .key
        .clone();
    h.msg(ChatMsg::Retry(key));
    assert!(h.writes()[0].contains("lost"));
    assert!(
        h.files.outbox(&name).is_empty(),
        "a restart must not bring it back"
    );
}

#[test]
fn a_chat_opened_while_disconnected_dials_once_the_connection_returns() {
    let mut h = Harness::new();
    h.exec(
        |t| *t == ExecTag::Status,
        r#"{"name":"chat-a","state":"running","logBytes":10,"cwd":"/home/sam/web","created":100,"turn":"idle"}"#,
    );
    h.run(|c, now, out| c.on_dropped(now, out));
    h.msg(ChatMsg::Select("chat-a".into()));
    let jobs = h.take();
    assert!(h.dial_of(&jobs).is_none());
    h.run(|c, now, out| c.on_connected(now, out));
    h.run(|c, now, out| c.on_tick(now, out));
    let jobs = h.take();
    assert!(h.dial_of(&jobs).is_some(), "{jobs:?}");
}

#[test]
fn stop_reads_stopped_only_once_the_cancel_landed() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.msg(ChatMsg::DraftEdited {
        text: "go".into(),
        cursor_byte: 2,
    });
    h.msg(ChatMsg::Send);
    h.writes();
    h.msg(ChatMsg::Stop);
    let tag = h
        .take()
        .into_iter()
        .find_map(|j| match j {
            ChatJob::Write {
                tag: Some(tag),
                ack: true,
                ..
            } => Some(tag),
            _ => None,
        })
        .expect("an acknowledged cancel");
    let stopped = |h: &mut Harness| {
        rows(&h.screen())
            .iter()
            .any(|r| matches!(r, RowBody::Notice(t) if t == "Stopped"))
    };
    assert!(!stopped(&mut h));
    h.msg(ChatMsg::WriteFailed {
        name: name.clone(),
        generation,
        tag: tag.clone(),
    });
    assert!(!stopped(&mut h));
    assert_eq!(h.screen().notice, "Stop didn't reach the agent. Try again.");
    h.msg(ChatMsg::Written {
        name,
        generation,
        tag,
    });
    assert!(stopped(&mut h));
}

#[test]
fn a_prompt_that_fails_after_a_redial_is_taken_out_of_the_stored_journal() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.msg(ChatMsg::DraftEdited {
        text: "late".into(),
        cursor_byte: 4,
    });
    h.msg(ChatMsg::Send);
    let tag = h
        .take()
        .into_iter()
        .find_map(|j| match j {
            ChatJob::Write { tag: Some(tag), .. } => Some(tag),
            _ => None,
        })
        .unwrap();
    h.run(|c, now, out| c.leave_active(now, out));
    assert!(
        h.files
            .journal(&name)
            .entries
            .iter()
            .any(|e| e.text.as_deref() == Some("late"))
    );
    h.msg(ChatMsg::WriteFailed {
        name: name.clone(),
        generation,
        tag,
    });
    assert!(
        !h.files
            .journal(&name)
            .entries
            .iter()
            .any(|e| e.text.as_deref() == Some("late"))
    );
    assert_eq!(h.files.outbox(&name).len(), 1);
}

#[test]
fn an_idle_open_chat_does_not_rewrite_its_snapshot() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.exec(
        |t| {
            matches!(
                t,
                ExecTag::Inspect {
                    why: InspectWhy::Learn,
                    ..
                }
            )
        },
        &format!("{name}\trunning\t4096\t/home/sam/proj\t300\tnpx\n"),
    );
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}"#,
    );
    h.now += 4000;
    h.run(|c, now, out| c.on_tick(now, out));
    assert!(h.files.snapshot(&name).is_some());
    h.files.clear_snapshot(&name);
    for _ in 0..3 {
        h.now += 4000;
        h.run(|c, now, out| c.on_tick(now, out));
    }
    assert!(h.files.snapshot(&name).is_none());
}

#[test]
fn answering_a_card_hands_the_keyboard_back_to_the_composer() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","title":"Run ls","kind":"execute"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"}]}}"#,
    );
    let before = h.screen().focus_seq;
    h.msg(ChatMsg::Approve("allow".into()));
    assert!(h.screen().focus_seq > before);
}

#[test]
fn picking_one_answer_of_a_longer_question_keeps_the_keyboard_on_the_card() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":"q1","method":"elicitation/create","params":{"sessionId":"s1","message":"Setup?","requestedSchema":{"type":"object","properties":{"a":{"type":"string","oneOf":[{"const":"x","title":"X"}]},"b":{"type":"string","title":"Notes"}}}}}"#,
    );
    let before = h.screen().focus_seq;
    h.msg(ChatMsg::QuestionChoose {
        field: "a".into(),
        value: "x".into(),
    });
    assert_eq!(h.screen().focus_seq, before);
    h.msg(ChatMsg::QuestionSubmit);
    assert!(h.screen().focus_seq > before);
}

#[test]
fn a_queued_message_waits_above_the_composer_until_the_agent_starts_it() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    for text in ["one", "two"] {
        h.msg(ChatMsg::DraftEdited {
            text: text.into(),
            cursor_byte: text.len(),
        });
        h.msg(ChatMsg::Send);
    }
    h.writes();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"Working on one"}}}}"#,
    );
    let s = h.screen();
    assert_eq!(s.queued, ["two"]);
    assert!(
        !rows(&s)
            .iter()
            .any(|r| matches!(r, RowBody::User { text, .. } if text == "two")),
        "not in the transcript while it waits"
    );

    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#,
    );
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"type":"text","text":"Working on two"}}}}"#,
    );
    let s = h.screen();
    assert!(s.queued.is_empty());
    let rows = rows(&s);
    assert!(matches!(rows[1], RowBody::Markdown(md) if md.text == "Working on one"));
    assert!(matches!(rows[2], RowBody::User { text, .. } if text == "two"));
}

#[test]
fn a_chat_started_elsewhere_on_a_shared_holder_is_joined_live() {
    let mut h = Harness::new();
    h.exec(
        |t| *t == ExecTag::Status,
        r#"{"name":"chat-a","state":"running","logBytes":10,"cwd":"/home/sam/web","created":100,"turn":"idle","multiClient":true}"#,
    );
    h.msg(ChatMsg::Select("chat-a".into()));
    let jobs = h.take();
    let (_, _, command) = h.dial_of(&jobs).unwrap();
    assert!(!command.contains("--spawn"), "{command}");
    let client = command
        .split("--client '")
        .nth(1)
        .and_then(|rest| rest.split('\'').next())
        .expect("names itself")
        .to_string();
    h.jobs = jobs;
    let (name, generation, writes) = h.open_stream();
    assert!(writes.is_empty(), "no handshake of its own: {writes:?}");
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":"other-2","result":{"sessionId":"s1"}}"#,
    );
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","method":"_tether/client","params":{"client":"other","message":{"jsonrpc":"2.0","id":"other-3","method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"Started on the phone"}]}}}}"#,
    );
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":"other-3","result":{"stopReason":"end_turn"}}"#,
    );
    h.settle();
    let s = h.screen();
    assert_eq!(s.composer.banner, "");
    assert!(matches!(rows(&s)[0], RowBody::User { text, .. } if text == "Started on the phone"));

    h.msg(ChatMsg::DraftEdited {
        text: "And from the desktop".into(),
        cursor_byte: 20,
    });
    h.msg(ChatMsg::Send);
    let writes = h.writes();
    assert!(
        writes[0].contains(&format!("\"id\":\"{client}-1\"")),
        "{writes:?}"
    );
    assert!(writes[0].contains("\"sessionId\":\"s1\""), "{writes:?}");
}

#[test]
fn stop_sends_the_queued_messages_as_the_next_prompt() {
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    for text in ["one", "two", "three"] {
        h.msg(ChatMsg::DraftEdited {
            text: text.into(),
            cursor_byte: text.len(),
        });
        h.msg(ChatMsg::Send);
    }
    h.writes();
    assert_eq!(h.screen().queued, ["two", "three"]);
    h.msg(ChatMsg::Stop);
    let tag = h
        .take()
        .into_iter()
        .find_map(|j| match j {
            ChatJob::Write {
                tag: Some(tag),
                ack: true,
                ..
            } => Some(tag),
            _ => None,
        })
        .expect("an acknowledged cancel");
    h.msg(ChatMsg::Written {
        name: name.clone(),
        generation,
        tag,
    });
    let writes = h.writes();
    let resent: Vec<&String> = writes
        .iter()
        .filter(|w| w.contains("session/prompt"))
        .collect();
    assert_eq!(resent.len(), 1, "{writes:?}");
    assert!(resent[0].contains(r#""text":"two\n\nthree""#), "{writes:?}");
    let users = |s: &ChatScreen| -> Vec<String> {
        rows(s)
            .iter()
            .filter_map(|r| match r {
                RowBody::User { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    };
    let s = h.screen();
    assert_eq!(
        s.queued,
        ["two\n\nthree"],
        "waits for the stopped turn to end"
    );
    assert_eq!(
        users(&s),
        ["one"],
        "the dropped messages left the transcript"
    );

    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"cancelled"}}"#,
    );
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"type":"text","text":"On it"}}}}"#,
    );
    let s = h.screen();
    assert!(s.queued.is_empty());
    assert_eq!(users(&s), ["one", "two\n\nthree"]);
}

#[cfg(debug_assertions)]
#[test]
fn background_commands_notices_and_compaction_reach_the_screen() {
    use super::view::EntryBody;
    let mut h = Harness::new();
    h.chats.dev_sample("claude", t(h.now));
    let s = h.screen();

    assert_eq!(s.tasks.len(), 2);
    assert_eq!(s.tasks[0].title, "bun run dev --port 3000");
    let sample = s.tabs.iter().find(|t| t.name == "sample").unwrap();
    assert_eq!((sample.state, sample.label.as_str()), (5, "2 tasks"));
    let other = s.tabs.iter().find(|t| t.name == "other").unwrap();
    assert_eq!((other.state, other.label.as_str()), (5, "2 tasks"));

    let badges = s
        .rows
        .iter()
        .filter_map(|r| match &r.body {
            RowBody::Tools(entries) => Some(entries),
            _ => None,
        })
        .flatten()
        .filter(|e| {
            matches!(
                e.body,
                EntryBody::Tool {
                    background: true,
                    ..
                }
            )
        })
        .count();
    assert_eq!(badges, 2);
    let severities: Vec<u8> = s
        .rows
        .iter()
        .filter_map(|r| match &r.body {
            RowBody::AgentNotice { severity, .. } => Some(*severity),
            _ => None,
        })
        .collect();
    assert_eq!(severities, [2, 1]);
    assert!(s.rows.iter().any(|r| matches!(
        &r.body,
        RowBody::Compaction { state: 1, summary, open: false, .. } if summary.starts_with("1. Primary")
    )));

    let key = s.tasks[0].key.clone();
    h.msg(ChatMsg::OpenTool(key));
    assert!(h.screen().rows.iter().any(|r| matches!(
        &r.body,
        RowBody::Tools(entries) if entries.iter().any(|e| matches!(e.body, EntryBody::Tool { open: true, .. }))
    )));
}

fn options_json(model: &str, effort: &str) -> String {
    let select = |id: &str, current: &str, values: &[&str]| {
        let choices: Vec<String> = values
            .iter()
            .map(|v| format!(r#"{{"value":"{v}","name":"{v}"}}"#))
            .collect();
        format!(
            r#"{{"id":"{id}","name":"{id}","type":"select","currentValue":"{current}","options":[{}]}}"#,
            choices.join(",")
        )
    };
    format!(
        "[{},{},{}]",
        select("mode", "default", &["default", "plan"]),
        select("model", model, &["default", "opus", "sonnet"]),
        select("effort", effort, &["low", "medium", "high"]),
    )
}

#[test]
fn a_new_chat_sets_the_stored_defaults_one_after_the_other_and_shows_no_error() {
    let mut h = Harness::new();
    let mut defaults = ChatDefaults::default();
    defaults.remember("claude", "model", "opus");
    defaults.remember("claude", "effort", "high");
    defaults.remember("claude", "mode", "plan");
    h.chats.set_defaults(defaults);
    let name = h.new_chat();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
    );
    h.writes();
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s1","configOptions":{}}}}}"#,
            options_json("default", "medium")
        ),
    );
    let sets = |w: &[String]| -> Vec<String> {
        w.iter()
            .filter(|l| l.contains("session/set_config_option"))
            .cloned()
            .collect()
    };
    let first = sets(&h.writes());
    assert_eq!(first.len(), 1, "one at a time");
    assert!(first[0].contains(r#""configId":"model""#) && first[0].contains(r#""value":"opus""#));
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":{}}}}}"#,
            options_json("opus", "medium")
        ),
    );
    let second = sets(&h.writes());
    assert!(
        second[0].contains(r#""configId":"effort""#) && second[0].contains(r#""value":"high""#)
    );
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"result":{{"configOptions":{}}}}}"#,
            options_json("opus", "high")
        ),
    );
    let third = sets(&h.writes());
    assert!(third[0].contains(r#""configId":"mode""#) && third[0].contains(r#""value":"plan""#));
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"nope"}}"#,
    );
    h.settle();
    assert!(sets(&h.writes()).is_empty());
    assert!(
        h.remembered.is_empty(),
        "applying a default is not a user choice"
    );
    assert_eq!(h.screen().composer.banner, "");
}

fn start_with_defaults(h: &mut Harness, stored: &[(&str, &str)]) -> (String, u64) {
    let mut defaults = ChatDefaults::default();
    for (id, value) in stored {
        defaults.remember("claude", id, value);
    }
    h.chats.set_defaults(defaults);
    let name = h.new_chat();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
    );
    h.writes();
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s1","configOptions":{}}}}}"#,
            options_json("default", "medium")
        ),
    );
    h.settle();
    (name, generation)
}

#[test]
fn a_user_change_of_the_option_being_applied_is_not_taken_for_the_default() {
    let mut h = Harness::new();
    let (name, generation) = start_with_defaults(&mut h, &[("model", "opus")]);
    assert!(h.writes()[0].contains(r#""value":"opus""#));
    h.msg(ChatMsg::ControlsChoose {
        id: "model".into(),
        value: "sonnet".into(),
    });
    assert!(h.writes()[0].contains(r#""value":"sonnet""#));
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":{}}}}}"#,
            options_json("opus", "medium")
        ),
    );
    assert!(
        h.remembered.is_empty(),
        "the default is not a user choice: {:?}",
        h.remembered
    );
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"result":{{"configOptions":{}}}}}"#,
            options_json("sonnet", "medium")
        ),
    );
    assert_eq!(
        h.remembered,
        vec![("model".to_string(), "sonnet".to_string())]
    );
    assert_eq!(h.screen().composer.banner, "");
}

#[test]
fn a_default_is_not_sent_over_an_option_the_user_changed_during_the_chain() {
    let mut h = Harness::new();
    let (name, generation) = start_with_defaults(&mut h, &[("model", "opus"), ("effort", "high")]);
    h.writes();
    h.msg(ChatMsg::ControlsChoose {
        id: "effort".into(),
        value: "low".into(),
    });
    h.writes();
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":{}}}}}"#,
            options_json("opus", "medium")
        ),
    );
    let after = h.writes();
    assert!(
        after
            .iter()
            .all(|l| !l.contains("session/set_config_option")),
        "{after:?}"
    );
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":4,"result":{{"configOptions":{}}}}}"#,
            options_json("opus", "low")
        ),
    );
    assert_eq!(
        h.remembered,
        vec![("effort".to_string(), "low".to_string())]
    );
}

#[test]
fn a_confirmed_user_change_is_remembered_but_an_unconfirmed_one_is_not() {
    let mut h = Harness::new();
    let name = h.new_chat();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
    );
    h.writes();
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s1","configOptions":{}}}}}"#,
            options_json("default", "medium")
        ),
    );
    h.settle();
    assert!(h.writes().is_empty());
    h.msg(ChatMsg::ControlsChoose {
        id: "model".into(),
        value: "sonnet".into(),
    });
    assert!(h.writes()[0].contains("session/set_config_option"));
    assert!(h.remembered.is_empty(), "not before the agent confirms");
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":{}}}}}"#,
            options_json("sonnet", "medium")
        ),
    );
    assert_eq!(
        h.remembered,
        vec![("model".to_string(), "sonnet".to_string())]
    );
    h.msg(ChatMsg::ControlsChoose {
        id: "effort".into(),
        value: "low".into(),
    });
    h.writes();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"no"}}"#,
    );
    assert_eq!(h.remembered.len(), 1);
}

#[test]
fn joining_or_resuming_a_chat_sets_no_defaults() {
    let mut h = Harness::new();
    let mut defaults = ChatDefaults::default();
    defaults.remember("claude", "model", "opus");
    h.chats.set_defaults(defaults);
    h.exec(
        |t| *t == ExecTag::Status,
        r#"{"name":"chat-a","state":"running","logBytes":10,"cwd":"/home/sam/web","created":100,"turn":"idle","multiClient":true}"#,
    );
    h.msg(ChatMsg::Select("chat-a".into()));
    let (name, generation, writes) = h.open_stream();
    assert!(writes.is_empty(), "{writes:?}");
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":"other-2","result":{{"sessionId":"s1","configOptions":{}}}}}"#,
            options_json("default", "medium")
        ),
    );
    h.settle();
    assert!(h.writes().is_empty(), "a joined chat keeps its own options");
}

fn select_json(id: &str, name: &str, current: &str, values: &[&str]) -> String {
    let choices: Vec<String> = values
        .iter()
        .map(|v| format!(r#"{{"value":"{v}","name":"{v}"}}"#))
        .collect();
    format!(
        r#"{{"id":"{id}","name":"{name}","type":"select","currentValue":"{current}","options":[{}]}}"#,
        choices.join(",")
    )
}

fn codex_options_json(effort: &str) -> String {
    format!(
        "[{},{},{}]",
        select_json("model", "Model", "gpt", &["gpt", "gpt-mini"]),
        select_json(
            "reasoning_effort",
            "Reasoning effort",
            effort,
            &["low", "medium", "high"]
        ),
        select_json("mode", "Mode", "agent", &["read-only", "agent"]),
    )
}

impl Harness {
    /// A New chat on `agent` in `~/proj`, started through the host checks.
    fn new_chat_on(&mut self, agent: &str) -> String {
        self.run(|c, now, out| c.open_new_chat(0, "~/proj".into(), now, out));
        self.msg(ChatMsg::NewChatAgent(agent.into()));
        self.msg(ChatMsg::NewChatStart);
        self.exec(|t| matches!(t, ExecTag::NewChat { .. }), CHECK_OK);
        self.exec(|t| matches!(t, ExecTag::NewChat { .. }), "/home/sam");
        self.chats.active().unwrap().to_string()
    }

    fn dialog(&mut self) -> super::view::NewChatView {
        self.screen().new_chat.expect("the dialog is open")
    }
}

#[test]
fn a_codex_chat_spawns_codex_is_recorded_and_wears_its_mark() {
    let mut h = Harness::new();
    let name = h.new_chat_on("codex");
    let jobs = h.take();
    let (_, _, command) = h.dial_of(&jobs).expect("a dial");
    assert!(
        command.contains("--spawn 'npx -y @agentclientprotocol/codex-acp@2.3.0'"),
        "{command}"
    );
    assert_eq!(h.files.agent(&name).as_deref(), Some("codex"));
    let screen = h.screen();
    assert_eq!(screen.tabs[0].agent, 1);
    assert_eq!(screen.header.agent_label, "Codex");
}

#[test]
fn the_next_dialog_opens_on_the_agent_picked_last() {
    let mut h = Harness::new();
    h.run(|c, now, out| c.open_new_chat(0, "~".into(), now, out));
    assert_eq!(h.dialog().agent, 0);
    h.msg(ChatMsg::NewChatCancel);
    let mut out = Out::default();
    h.chats
        .set_options_cache(Default::default(), "devbox.local:22", "opencode");
    h.chats.open_new_chat(0, "~".into(), t(h.now), &mut out);
    assert_eq!(h.dialog().agent, 2);
    h.msg(ChatMsg::NewChatCancel);
    h.msg(ChatMsg::NewChatCancel);
    h.run(|c, now, out| c.open_new_chat(0, "~".into(), now, out));
    h.msg(ChatMsg::NewChatAgent("codex".into()));
    h.msg(ChatMsg::NewChatStart);
    h.exec(|t| matches!(t, ExecTag::NewChat { .. }), CHECK_OK);
    h.exec(|t| matches!(t, ExecTag::NewChat { .. }), "/home/sam");
    h.run(|c, now, out| c.open_new_chat(0, "~".into(), now, out));
    assert_eq!(h.dialog().agent, 1, "Codex was the last one started");
}

#[test]
fn continuing_lists_the_picked_agents_conversations_and_reloads_on_a_change() {
    let mut h = Harness::new();
    h.run(|c, now, out| c.open_new_chat(1, "/srv/app".into(), now, out));
    let command = |jobs: Vec<ChatJob>| {
        jobs.into_iter().rev().find_map(|j| match j {
            ChatJob::Exec {
                tag: ExecTag::NewChat { .. },
                command,
            } => Some(command),
            _ => None,
        })
    };
    let first = command(h.take()).expect("a listing");
    assert!(first.contains("sessions '/srv/app'") && !first.contains("--agent-cmd"));
    h.msg(ChatMsg::NewChatAgent("opencode".into()));
    let second = command(h.take()).expect("a reload");
    assert!(
        second.contains(r#"--agent-cmd 'PATH="$HOME/.opencode/bin:$PATH" opencode acp'"#),
        "{second}"
    );
    h.msg(ChatMsg::NewChatAgent("opencode".into()));
    assert!(
        command(h.take()).is_none(),
        "the same agent changes nothing"
    );
}

#[test]
fn the_sign_in_row_names_each_agents_own_command() {
    for (agent, command) in [
        ("claude", "run claude to sign in"),
        ("codex", "run codex login to sign in"),
        ("opencode", "run opencode auth login to sign in"),
    ] {
        let mut h = Harness::new();
        let name = h.new_chat_on(agent);
        let (_, generation, _) = h.open_stream();
        h.feed(
            &name,
            generation,
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
        );
        h.writes();
        h.feed(
            &name,
            generation,
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}"#,
        );
        h.settle();
        let s = h.screen();
        assert!(
            matches!(rows(&s).last(), Some(RowBody::SignedOut { message, .. }) if message.contains(command)),
            "{agent}: {:?}",
            rows(&s).last()
        );
    }
}

#[test]
fn chats_this_device_did_not_start_take_their_agent_from_the_hosts_report() {
    let mut h = Harness::new();
    let lines = [
        r#"{"name":"chat-aaaaaa","state":"running","cwd":"/srv/a","spawn":"opencode acp","created":1}"#,
        r#"{"name":"chat-bbbbbb","state":"running","cwd":"/srv/b","created":2}"#,
        r#"{"name":"chat-cccccc","state":"running","cwd":"/srv/c","spawn":"mystery --acp","created":3}"#,
    ];
    h.exec(|t| *t == ExecTag::Status, &lines.join("\n"));
    let screen = h.screen();
    let agents: Vec<i8> = screen.tabs.iter().map(|t| t.agent).collect();
    assert_eq!(agents, [2, 0, -1]);
}

#[test]
fn a_settled_session_reports_its_options_once_for_the_new_chat_dialog() {
    let mut h = Harness::new();
    let name = h.new_chat_on("codex");
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
    );
    h.writes();
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s1","configOptions":{}}}}}"#,
            codex_options_json("medium")
        ),
    );
    assert!(h.seen.is_empty(), "not while the link is still catching up");
    h.settle();
    h.settle();
    assert_eq!(h.seen.len(), 1);
    assert_eq!(h.seen[0].0, "codex");
    let ids: Vec<_> = h.seen[0].1.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(ids, ["model", "reasoning_effort", "mode"]);
}

#[test]
fn the_dialogs_picks_are_applied_and_the_confirmed_ones_become_that_agents_defaults() {
    let mut h = Harness::new();
    let cached = vec![
        devsample_option("model", "Model", "gpt", &["gpt", "gpt-mini"]),
        devsample_option(
            "reasoning_effort",
            "Reasoning effort",
            "medium",
            &["low", "medium", "high"],
        ),
        devsample_option("mode", "Mode", "agent", &["read-only", "agent"]),
    ];
    assert!(h.chats.cache_options("codex", &cached));
    h.run(|c, now, out| c.open_new_chat(0, "~/proj".into(), now, out));
    h.msg(ChatMsg::NewChatAgent("codex".into()));
    let dialog = h.dialog();
    assert_eq!(dialog.summary, "gpt \u{b7} medium \u{b7} agent");
    assert_eq!(dialog.menus.len(), 3);
    h.msg(ChatMsg::NewChatPick {
        id: "reasoning_effort".into(),
        value: "high".into(),
    });
    let dialog = h.dialog();
    assert!(dialog.menus[1].changed && !dialog.menus[0].changed);
    h.msg(ChatMsg::NewChatStart);
    h.exec(|t| matches!(t, ExecTag::NewChat { .. }), CHECK_OK);
    h.exec(|t| matches!(t, ExecTag::NewChat { .. }), "/home/sam");
    let name = h.chats.active().unwrap().to_string();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
    );
    h.writes();
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s1","configOptions":{}}}}}"#,
            codex_options_json("medium")
        ),
    );
    let writes = h.writes();
    let set: Vec<_> = writes
        .iter()
        .filter(|l| l.contains("session/set_config_option"))
        .collect();
    assert_eq!(set.len(), 1, "{writes:?}");
    assert!(
        set[0].contains(r#""configId":"reasoning_effort""#) && set[0].contains(r#""value":"high""#)
    );
    assert!(h.remembered.is_empty(), "not before the agent confirms");
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":{}}}}}"#,
            codex_options_json("high")
        ),
    );
    assert_eq!(
        h.remembered,
        vec![("reasoning_effort".to_string(), "high".to_string())]
    );
}

#[test]
fn reset_applies_nothing_to_the_new_chat() {
    let mut h = Harness::new();
    let mut stored = ChatDefaults::default();
    stored.remember("codex", "reasoning_effort", "high");
    h.chats.set_defaults(stored);
    let cached = vec![devsample_option(
        "reasoning_effort",
        "Reasoning effort",
        "medium",
        &["low", "medium", "high"],
    )];
    h.chats.cache_options("codex", &cached);
    h.run(|c, now, out| c.open_new_chat(0, "~/proj".into(), now, out));
    h.msg(ChatMsg::NewChatAgent("codex".into()));
    assert_eq!(h.dialog().menus[0].value_name, "high");
    h.msg(ChatMsg::NewChatReset);
    assert_eq!(h.dialog().summary, "Codex's defaults");
    h.msg(ChatMsg::NewChatStart);
    h.exec(|t| matches!(t, ExecTag::NewChat { .. }), CHECK_OK);
    h.exec(|t| matches!(t, ExecTag::NewChat { .. }), "/home/sam");
    let name = h.chats.active().unwrap().to_string();
    let (_, generation, _) = h.open_stream();
    h.feed(
        &name,
        generation,
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
    );
    h.writes();
    h.feed(
        &name,
        generation,
        &format!(
            r#"{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s1","configOptions":{}}}}}"#,
            codex_options_json("medium")
        ),
    );
    assert!(
        h.writes()
            .iter()
            .all(|l| !l.contains("session/set_config_option"))
    );
}

fn devsample_option(
    id: &str,
    name: &str,
    current: &str,
    values: &[&str],
) -> tether_core::acp::message::ConfigOption {
    use tether_core::acp::message::{ConfigChoice, ConfigOption};
    ConfigOption {
        id: id.into(),
        name: name.into(),
        description: String::new(),
        category: None,
        current_value: current.into(),
        choices: values
            .iter()
            .map(|v| ConfigChoice {
                value: (*v).into(),
                name: (*v).into(),
                description: String::new(),
            })
            .collect(),
    }
}

#[test]
fn the_dialog_dims_the_agents_the_host_cannot_run_and_will_not_pick_them() {
    let mut h = Harness::new();
    h.run(|c, now, out| c.open_new_chat(0, "~".into(), now, out));
    h.exec(
        |t| matches!(t, ExecTag::AgentProbe),
        "tether=found\nversion={\"name\":\"tether\",\"protocol\":1}\nnode=ok\nopencode=missing\ncopilot=missing\n",
    );
    let dialog = h.dialog();
    assert_eq!(dialog.unavailable, [false, false, true, true]);
    assert_eq!(dialog.error, "");
    h.msg(ChatMsg::NewChatAgent("copilot".into()));
    let dialog = h.dialog();
    assert_eq!(dialog.agent, 0, "the pick is refused");
    assert!(
        dialog.error.contains("Copilot CLI on devbox.local"),
        "{}",
        dialog.error
    );
    h.msg(ChatMsg::NewChatAgent("codex".into()));
    let dialog = h.dialog();
    assert_eq!(dialog.agent, 1);
    assert_eq!(dialog.error, "");
}

#[test]
fn a_dialog_opening_on_an_agent_the_host_lacks_says_why() {
    let mut h = Harness::new();
    h.chats
        .set_options_cache(Default::default(), "devbox.local:22", "opencode");
    h.run(|c, now, out| c.open_new_chat(0, "~".into(), now, out));
    h.exec(
        |t| matches!(t, ExecTag::AgentProbe),
        "tether=found\nversion={\"name\":\"tether\",\"protocol\":1}\nnode=missing\nopencode=missing\n",
    );
    let dialog = h.dialog();
    assert_eq!(dialog.unavailable, [true, true, true, false]);
    assert!(
        dialog.error.contains("Install opencode"),
        "{}",
        dialog.error
    );
    h.msg(ChatMsg::NewChatMode(1));
    h.msg(ChatMsg::NewChatMode(0));
    assert!(
        h.dialog().error.contains("Install opencode"),
        "a mode change keeps the reason"
    );
}

// MARK: Workflows

const WORKFLOW_LAUNCH: &str = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"toolu_w","title":"Workflow","kind":"other","status":"completed","_meta":{"claudeCode":{"toolName":"Workflow"}}}}}"#;

fn workflow_line(status: &str) -> String {
    let (agent, tail) = if status == "running" {
        ("running", String::new())
    } else {
        (
            "stopped",
            r#","summary":"Stopped early","endedAt":100"#.into(),
        )
    };
    format!(
        r#"{{"toolCallId":"toolu_w","runId":"wf_x","title":"review","status":"{status}","startedAt":10,"phases":[{{"title":"Scan","agents":[{{"label":"a","state":"done","startedAt":10,"endedAt":50}},{{"label":"b","state":"{agent}","startedAt":20}}]}},{{"title":"Merge","agents":[]}}]{tail}}}"#
    )
}

fn workflow_asks(h: &mut Harness) -> Vec<(ExecTag, String)> {
    let jobs = h.take();
    let mut asks = Vec::new();
    for job in jobs {
        match job {
            ChatJob::Exec {
                tag: tag @ ExecTag::Workflows { .. },
                command,
            } => asks.push((tag, command)),
            other => h.jobs.push(other),
        }
    }
    asks
}

fn tick_for(h: &mut Harness, ms: u64) {
    h.now += ms;
    h.run(|c, now, out| c.on_tick(now, out));
}

fn workflow_chat(h: &mut Harness) -> (String, u64) {
    let (name, generation) = h.live_chat();
    h.feed(&name, generation, WORKFLOW_LAUNCH);
    (name, generation)
}

fn answer_workflows(h: &mut Harness, tag: ExecTag, output: &str) {
    h.msg(ChatMsg::ExecDone {
        tag,
        result: Ok(output.to_string()),
    });
}

/// The state of the first tool entry on screen.
fn first_tool_state(s: &ChatScreen) -> Option<super::view::ToolState> {
    s.rows.iter().find_map(|r| match &r.body {
        RowBody::Tools(entries) => entries.iter().find_map(|e| match &e.body {
            super::view::EntryBody::Tool { state, .. } => Some(*state),
            _ => None,
        }),
        _ => None,
    })
}

#[test]
fn a_workflow_call_is_polled_with_the_quoted_session_id_until_the_host_reports_its_end() {
    use super::view::ToolState;
    let mut h = Harness::new();
    workflow_chat(&mut h);
    tick_for(&mut h, 10);
    let mut asks = workflow_asks(&mut h);
    assert_eq!(asks.len(), 1);
    let (tag, command) = asks.remove(0);
    assert!(
        command.contains("tether acp workflows --session 's1' --json 2>&1"),
        "{command}"
    );
    tick_for(&mut h, 10);
    assert!(workflow_asks(&mut h).is_empty(), "one ask at a time");

    answer_workflows(&mut h, tag, &workflow_line("running"));
    let s = h.screen();
    assert_eq!(s.workflows.len(), 1);
    assert_eq!(
        s.workflows[0].text,
        "review \u{00B7} Scan \u{00B7} 1/2 agents"
    );
    assert_eq!(first_tool_state(&s), Some(ToolState::Running));

    tick_for(&mut h, 4000);
    assert!(workflow_asks(&mut h).is_empty(), "not before the interval");
    tick_for(&mut h, 1500);
    let (tag, _) = workflow_asks(&mut h).remove(0);
    answer_workflows(&mut h, tag, &workflow_line("completed"));
    let s = h.screen();
    assert!(s.workflows.is_empty());
    assert_eq!(first_tool_state(&s), Some(ToolState::Done));
    tick_for(&mut h, 60_000);
    assert!(
        workflow_asks(&mut h).is_empty(),
        "no more asks once the run is over"
    );
}

#[test]
fn a_killed_run_reads_failed_and_its_sheet_shows_stopped_agents_and_the_summary() {
    use super::view::ToolState;
    let mut h = Harness::new();
    workflow_chat(&mut h);
    tick_for(&mut h, 10);
    let (tag, _) = workflow_asks(&mut h).remove(0);
    answer_workflows(&mut h, tag, &workflow_line("killed"));
    let s = h.screen();
    assert!(s.workflows.is_empty());
    assert_eq!(first_tool_state(&s), Some(ToolState::Failed));
    let key = s
        .rows
        .iter()
        .find_map(|r| match &r.body {
            RowBody::Tools(entries) => entries.first().map(|e| e.key.clone()),
            _ => None,
        })
        .expect("the Workflow row");

    h.msg(ChatMsg::Toggle(key));
    let sheet = h
        .screen()
        .workflow
        .expect("tapping the row opens the sheet");
    assert_eq!(sheet.status, "killed");
    assert_eq!(sheet.state, 2);
    assert_eq!(sheet.summary, "Stopped early");
    assert_eq!(sheet.counts, "1/2 agents");
    assert_eq!(sheet.phases[0].agents[1].state, 2);
    assert_eq!(
        sheet.phases[0].agents[1].elapsed, "",
        "a stopped agent has no clock"
    );
    assert!(sheet.phases[1].agents.is_empty());
    h.msg(ChatMsg::Escape);
    assert!(h.screen().workflow.is_none());
}

#[test]
fn the_strip_opens_the_sheet_and_escape_closes_it_before_other_overlays() {
    let mut h = Harness::new();
    workflow_chat(&mut h);
    tick_for(&mut h, 10);
    let (tag, _) = workflow_asks(&mut h).remove(0);
    answer_workflows(&mut h, tag, &workflow_line("running"));
    let call = h.screen().workflows[0].call_id.clone();
    h.msg(ChatMsg::Controls);
    h.msg(ChatMsg::OpenWorkflow(call));
    let s = h.screen();
    let sheet = s.workflow.expect("the sheet");
    assert_eq!(sheet.state, 0);
    assert_eq!(sheet.phases[0].agents[1].state, 0);
    assert!(s.controls.is_some());
    h.msg(ChatMsg::Escape);
    let s = h.screen();
    assert!(s.workflow.is_none());
    assert!(s.controls.is_some());
}

#[test]
fn a_run_the_host_does_not_list_says_so_in_its_sheet() {
    let mut h = Harness::new();
    workflow_chat(&mut h);
    h.msg(ChatMsg::OpenWorkflow("toolu_w".into()));
    let sheet = h.screen().workflow.unwrap();
    assert!(sheet.missing);
}

#[test]
fn a_chat_without_a_workflow_call_never_asks() {
    let mut h = Harness::new();
    h.live_chat();
    tick_for(&mut h, 10_000);
    assert!(workflow_asks(&mut h).is_empty());
}

#[test]
fn an_old_host_is_asked_once_and_the_row_keeps_what_acp_said() {
    use super::view::ToolState;
    let mut h = Harness::new();
    workflow_chat(&mut h);
    tick_for(&mut h, 10);
    let (tag, _) = workflow_asks(&mut h).remove(0);
    answer_workflows(&mut h, tag, "tether: unknown acp command \"workflows\"");
    tick_for(&mut h, 60_000);
    assert!(workflow_asks(&mut h).is_empty());
    let s = h.screen();
    assert!(s.workflows.is_empty());
    assert_eq!(first_tool_state(&s), Some(ToolState::Done));
}

#[test]
fn polling_stops_when_the_chat_leaves_the_front_and_an_old_answer_is_dropped() {
    let mut h = Harness::new();
    let (name, _) = workflow_chat(&mut h);
    tick_for(&mut h, 10);
    let (stale, _) = workflow_asks(&mut h).remove(0);
    h.run(|c, now, out| c.leave_active(now, out));
    h.take();
    tick_for(&mut h, 30_000);
    assert!(
        workflow_asks(&mut h).is_empty(),
        "nothing is asked from the background"
    );
    answer_workflows(&mut h, stale, &workflow_line("running"));
    assert!(
        h.chats.sessions[&name].workflows.runs().is_empty(),
        "an answer for the older dial changes nothing"
    );
}

#[test]
fn a_dropped_connection_stops_the_polling() {
    let mut h = Harness::new();
    workflow_chat(&mut h);
    tick_for(&mut h, 10);
    assert_eq!(workflow_asks(&mut h).len(), 1);
    h.run(|c, now, out| c.on_dropped(now, out));
    tick_for(&mut h, 30_000);
    assert!(workflow_asks(&mut h).is_empty());
}

#[test]
fn only_a_running_run_ticks_the_open_sheet_each_second() {
    for (status, ticks) in [("running", true), ("killed", false)] {
        let mut h = Harness::new();
        workflow_chat(&mut h);
        tick_for(&mut h, 10);
        let (tag, _) = workflow_asks(&mut h).remove(0);
        answer_workflows(&mut h, tag, &workflow_line(status));
        h.msg(ChatMsg::OpenWorkflow("toolu_w".into()));
        tick_for(&mut h, 2000);
        h.chats.dirty = false;
        tick_for(&mut h, 1100);
        assert_eq!(h.chats.dirty, ticks, "{status}");
    }
}

#[test]
fn an_unchanged_answer_neither_redraws_nor_marks_the_chat_changed() {
    let mut h = Harness::new();
    let (name, _) = workflow_chat(&mut h);
    tick_for(&mut h, 10);
    let (tag, _) = workflow_asks(&mut h).remove(0);
    answer_workflows(&mut h, tag, &workflow_line("running"));
    tick_for(&mut h, 5100);
    let (tag, _) = workflow_asks(&mut h).remove(0);
    h.screen();
    let rev = h.chats.sessions[&name].changed_since_shown();
    h.chats.dirty = false;
    h.msg(ChatMsg::ExecDone {
        tag,
        result: Ok(workflow_line("running")),
    });
    assert!(!h.chats.dirty);
    assert_eq!(h.chats.sessions[&name].changed_since_shown(), rev);
}

#[test]
fn the_sample_shows_a_running_and_an_ended_workflow() {
    for (kind, running) in [("running", true), ("ended", false)] {
        let mut h = Harness::new();
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        h.chats.dev_sample("claude", t(h.now));
        let sample = h.chats.sessions.get_mut("sample").unwrap();
        sample
            .workflows
            .set_runs(devsample::workflow_runs(kind, wall));
        h.msg(ChatMsg::OpenWorkflow(devsample::WORKFLOW_CALL.into()));
        let s = h.screen();
        assert_eq!(s.workflows.len(), usize::from(running));
        let sheet = s.workflow.unwrap();
        assert_eq!(sheet.state, if running { 0 } else { 2 });
    }
}

#[test]
fn project_sidebar_pins_once_and_keeps_archived_waiting_chats_discoverable() {
    let mut h = Harness::new();
    h.exec(|t|*t==ExecTag::Status,concat!(
        r#"{"name":"p","state":"running","cwd":"/srv/a","created":1,"pinned":true,"customTitle":"Pinned title"}"#,"\n",
        r#"{"name":"w","state":"running","cwd":"/srv/b","created":2,"archived":true,"turn":"waiting"}"#,"\n",
        r#"{"name":"a","state":"ended","cwd":"/srv/a","created":3,"archived":true}"#));
    let s = h.screen();
    assert_eq!(
        s.sidebar
            .iter()
            .filter_map(|r| r.tab.as_ref())
            .filter(|t| t.name == "p")
            .count(),
        1
    );
    assert!(s.sidebar.iter().any(|r| r.section == "Pinned"));
    assert!(
        s.sidebar
            .iter()
            .any(|r| r.section == "Needs you · archived")
    );
    assert!(
        !s.sidebar
            .iter()
            .filter_map(|r| r.tab.as_ref())
            .any(|t| t.name == "a")
    );
    h.msg(ChatMsg::Archived(true));
    let s = h.screen();
    assert!(
        s.sidebar
            .iter()
            .filter_map(|r| r.tab.as_ref())
            .any(|t| t.name == "a")
    );
}

#[test]
fn archiving_does_not_issue_a_kill_and_restoring_uses_metadata() {
    let mut h = Harness::new();
    h.take();
    h.msg(ChatMsg::Archive("chat".into()));
    let jobs = h.take();
    assert!(jobs.iter().any(|j|matches!(j,ChatJob::Exec{tag:ExecTag::Organize{name},command} if name=="chat" && command.contains("archived"))));
    assert!(!jobs.iter().any(|j| matches!(
        j,
        ChatJob::Exec {
            tag: ExecTag::Kill { .. },
            ..
        }
    )));
    h.msg(ChatMsg::Restore("chat".into()));
    assert!(h.take().iter().any(|j|matches!(j,ChatJob::Exec{tag:ExecTag::Organize{..},command} if command.contains("false"))));
}

#[test]
fn usage_polling_is_bounded_and_hidden_sidebar_never_polls() {
    let mut h = Harness::new();
    h.take();
    h.chats.usage_loading = false;
    h.chats.usage_asked = Some(t(0));
    h.run(|c, _, out| c.on_tick(t(59999), out));
    assert!(!h.take().iter().any(|j| matches!(
        j,
        ChatJob::Exec {
            tag: ExecTag::Usage,
            ..
        }
    )));
    h.chats.usage_visible = false;
    h.run(|c, _, out| c.on_tick(t(60001), out));
    assert!(!h.take().iter().any(|j| matches!(
        j,
        ChatJob::Exec {
            tag: ExecTag::Usage,
            ..
        }
    )));
    h.chats.usage_visible = true;
    h.run(|c, _, out| c.on_tick(t(60001), out));
    assert_eq!(
        h.take()
            .iter()
            .filter(|j| matches!(
                j,
                ChatJob::Exec {
                    tag: ExecTag::Usage,
                    ..
                }
            ))
            .count(),
        1
    );
}

#[test]
fn creating_a_branch_preserves_original_and_opens_distinct_unsent_draft() {
    let mut h = Harness::new();
    let (parent, _) = h.live_chat();
    h.msg(ChatMsg::DraftEdited {
        text: "original prompt".into(),
        cursor_byte: 15,
    });
    h.msg(ChatMsg::Send);
    let id = h
        .chats
        .active_session()
        .unwrap()
        .state()
        .items
        .iter()
        .find(|i| matches!(i.kind, tether_core::acp::reducer::ItemKind::User { .. }))
        .unwrap()
        .id;
    h.take();
    h.msg(ChatMsg::Branch(format!("item:{id}")));
    assert!(h.screen().branch.is_some());
    h.msg(ChatMsg::BranchCreate {
        title: "Alternative".into(),
        prompt: "edited prompt".into(),
    });
    assert_eq!(
        h.chats.active(),
        Some(parent.as_str()),
        "parent stays active before metadata acknowledgement"
    );
    let child_name = h.chats.pending_branch.as_ref().unwrap().0.clone();
    h.exec(|tag|matches!(tag,ExecTag::Organize{name} if name==&child_name),r#"{"title":"Alternative","pinned":false,"archived":false,"parent":{"name":"source","title":"Original","method":"copy"}}"#);
    let child = h.chats.active().unwrap().to_string();
    assert_ne!(child, parent);
    assert_eq!(h.chats.active_session().unwrap().draft, "edited prompt");
    assert_eq!(h.files.branch(&child).unwrap().parent.name, parent);
    assert!(h.chats.sessions.get(&parent).unwrap().state().items.iter().any(|i|matches!(&i.kind,tether_core::acp::reducer::ItemKind::User{text,..} if text=="original prompt")));
    assert!(
        !h.writes().iter().any(|s| s.contains("session/prompt")),
        "create must not send the prompt"
    );
}

#[test]
fn first_branch_seed_write_blocks_overlap_and_failure_keeps_explicit_retry() {
    use tether_core::acp::organization::{Branch, Parent};
    let mut h = Harness::new();
    let (name, generation) = h.live_chat();
    h.take();
    h.chats.sessions.get_mut(&name).unwrap().branch = Some(Branch {
        parent: Parent {
            name: "parent".into(),
            title: "Parent".into(),
            method: "copy".into(),
        },
        context: "Earlier context".into(),
        draft: "first".into(),
    });
    h.msg(ChatMsg::DraftEdited {
        text: "first".into(),
        cursor_byte: 5,
    });
    h.msg(ChatMsg::Send);
    let tag = h
        .take()
        .into_iter()
        .find_map(|j| match j {
            ChatJob::Write {
                tag: Some(tag),
                ack: true,
                ..
            } => Some(tag),
            _ => None,
        })
        .expect("first seed write requests acknowledgement");
    assert!(!h.chats.active_session().unwrap().can_send());
    h.msg(ChatMsg::DraftEdited {
        text: "second".into(),
        cursor_byte: 6,
    });
    h.msg(ChatMsg::Send);
    assert!(
        h.writes().is_empty(),
        "second prompt must wait for first send outcome"
    );
    h.msg(ChatMsg::WriteFailed {
        name: name.clone(),
        generation,
        tag,
    });
    assert!(h.chats.active_session().unwrap().can_send());
    assert_eq!(h.files.outbox(&name)[0].text, "first");
    let retry = h.chats.active_session().unwrap().outbox.persisted()[0].id;
    h.msg(ChatMsg::Retry(retry.to_string()));
    assert!(
        h.writes()
            .iter()
            .any(|wire| wire.contains("tether/branchContext")),
        "explicit retry keeps the context"
    );
}

#[test]
fn branch_metadata_failure_keeps_parent_and_editable_prompt_without_spawning() {
    let mut h = Harness::new();
    let (parent, _) = h.live_chat();
    h.take();
    h.msg(ChatMsg::DraftEdited {
        text: "original".into(),
        cursor_byte: 8,
    });
    h.msg(ChatMsg::Send);
    h.take();
    let id = h
        .chats
        .active_session()
        .unwrap()
        .state()
        .items
        .iter()
        .find(|i| matches!(i.kind, tether_core::acp::reducer::ItemKind::User { .. }))
        .unwrap()
        .id;
    h.msg(ChatMsg::Branch(format!("item:{id}")));
    h.msg(ChatMsg::BranchCreate {
        title: "Alternative".into(),
        prompt: "edited".into(),
    });
    let child = h.chats.pending_branch.as_ref().unwrap().0.clone();
    h.exec(
        |tag| matches!(tag,ExecTag::Organize{name} if name==&child),
        "unknown acp command organize",
    );
    assert_eq!(h.chats.active(), Some(parent.as_str()));
    assert!(h.chats.pending_branch.is_none());
    assert_eq!(
        h.chats.branch_dialog.as_ref().unwrap().branch.draft,
        "edited"
    );
    assert!(
        !h.take().iter().any(|j| matches!(j, ChatJob::Dial { .. })),
        "failed organization never spawns a child"
    );
}

#[test]
fn dropping_while_a_branch_is_pending_keeps_the_dialog_for_a_retry() {
    let mut h = Harness::new();
    let (parent, _) = h.live_chat();
    h.take();
    h.msg(ChatMsg::DraftEdited {
        text: "original".into(),
        cursor_byte: 8,
    });
    h.msg(ChatMsg::Send);
    h.take();
    let id = h
        .chats
        .active_session()
        .unwrap()
        .state()
        .items
        .iter()
        .find(|i| matches!(i.kind, tether_core::acp::reducer::ItemKind::User { .. }))
        .unwrap()
        .id;
    h.msg(ChatMsg::Branch(format!("item:{id}")));
    h.msg(ChatMsg::BranchCreate {
        title: "Alternative".into(),
        prompt: "edited".into(),
    });
    assert!(h.chats.pending_branch.is_some());
    h.run(|c, now, out| c.on_dropped(now, out));
    assert!(h.chats.pending_branch.is_none());
    assert_eq!(h.chats.active(), Some(parent.as_str()));
    assert_eq!(
        h.chats.branch_dialog.as_ref().unwrap().branch.draft,
        "edited"
    );
    h.msg(ChatMsg::BranchCancel);
    assert!(h.chats.branch_dialog.is_none(), "cancel works again");
}
