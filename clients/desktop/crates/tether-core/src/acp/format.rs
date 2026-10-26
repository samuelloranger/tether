//! What the chat screens say and decide that needs no UI: labels, the header status line, the
//! composer's send rule, permission-card layout, the outbox, the link phases and resume rules.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::host::ChatSummary;
use super::images::ImageAttachment;
use super::journal::{Journal, Snapshot};
use super::message::{Command, Cost, PermissionOption};
use super::reducer::ChatState;

/// The folder name; a chat started in the home directory or the root has no better label.
pub fn folder_name(cwd: &str) -> String {
    let trimmed = cwd.trim_matches('/');
    match trimmed.split('/').rfind(|p| !p.is_empty()) {
        Some(last) => last.to_string(),
        None if cwd == "/" => "/".to_string(),
        None => "Home".to_string(),
    }
}

/// The folder a chat sits in, for the row's subtitle; None at the root or for a bare `~`.
pub fn parent_path(cwd: &str) -> Option<String> {
    let mut parts: Vec<&str> = cwd.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || cwd == "~" {
        return None;
    }
    parts.pop();
    let rooted = cwd.starts_with('/');
    if parts.is_empty() {
        return rooted.then(|| "/".to_string());
    }
    Some(format!(
        "{}{}",
        if rooted { "/" } else { "" },
        parts.join("/")
    ))
}

/// A short agent name from the command the host spawned, None when it is not a known one.
pub fn agent_label(spawn: &str) -> Option<&'static str> {
    let lower = spawn.to_lowercase();
    [
        ("claude", "Claude"),
        ("codex", "Codex"),
        ("gemini", "Gemini"),
        ("cursor", "Cursor"),
    ]
    .into_iter()
    .find(|(needle, _)| lower.contains(needle))
    .map(|(_, label)| label)
}

/// Used share of the context window in 0..=1; None when the agent reported no size.
pub fn context_fraction(used: Option<i64>, size: Option<i64>) -> Option<f64> {
    let (used, size) = (used?, size?);
    if size <= 0 {
        return None;
    }
    Some((used as f64 / size as f64).clamp(0.0, 1.0))
}

/// 31043 -> "31k", 1_000_000 -> "1M".
pub fn compact_count(value: i64) -> String {
    if value >= 1_000_000 {
        let millions = value as f64 / 1_000_000.0;
        if millions == millions.round() {
            format!("{}M", millions as i64)
        } else {
            format!("{millions:.1}M")
        }
    } else if value >= 1_000 {
        format!("{}k", (value as f64 / 1_000.0).round() as i64)
    } else {
        value.to_string()
    }
}

pub fn context_summary(used: Option<i64>, size: Option<i64>) -> Option<String> {
    let (used, size) = (used?, size?);
    if size <= 0 {
        return None;
    }
    let percent = ((used as f64 / size as f64 * 100.0).round() as i64).clamp(0, 100);
    Some(format!(
        "{} / {} \u{00B7} {percent}%",
        compact_count(used),
        compact_count(size)
    ))
}

/// A path relative to the chat's folder when it sits inside it.
pub fn relative_path(path: &str, cwd: &str) -> String {
    let base = if cwd.ends_with('/') {
        cwd.to_string()
    } else {
        format!("{cwd}/")
    };
    match path.strip_prefix(&base) {
        Some(rest) => rest.to_string(),
        None => path.to_string(),
    }
}

/// "$0.16" below one dollar, "$1.2" from one dollar up; other currencies get their code.
pub fn cost(cost: &Cost) -> String {
    let amount = cost.amount.max(0.0);
    let number = if amount >= 1.0 {
        format!("{amount:.1}")
    } else {
        format!("{amount:.2}")
    };
    let currency = cost.currency.to_uppercase();
    if currency == "USD" {
        format!("${number}")
    } else {
        format!("{number} {currency}")
    }
}

/// "2%" for the share of the context window in use; None when the agent reported no size.
pub fn context_percent(used: Option<i64>, size: Option<i64>) -> Option<String> {
    let fraction = context_fraction(used, size)?;
    Some(format!("{}%", (fraction * 100.0).round() as i64))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeTint {
    Accent,
    Success,
    Secondary,
    Danger,
}

impl ModeTint {
    pub fn from_mode(mode_id: Option<&str>) -> Self {
        match mode_id {
            Some("plan") => Self::Accent,
            Some("acceptEdits") => Self::Success,
            Some("bypassPermissions") => Self::Danger,
            _ => Self::Secondary,
        }
    }
}

/// What the header's second line says; empty until the agent has sent its options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusLine {
    pub model: Option<String>,
    pub mode: Option<String>,
    pub tint: ModeTint,
    pub percent: Option<String>,
    pub cost: Option<String>,
}

impl StatusLine {
    pub fn new(state: &ChatState) -> Self {
        let mode_value = state.option("mode").map(|o| o.current_value.as_str());
        Self {
            model: state
                .current_choice("model")
                .or_else(|| state.model_id.clone()),
            mode: mode_value
                .and_then(Self::short_mode)
                .or_else(|| state.current_choice("mode")),
            tint: ModeTint::from_mode(mode_value),
            percent: context_percent(state.context_used, state.context_size),
            cost: state.cost.as_ref().map(cost),
        }
    }

    /// "Bypass permissions" would crowd the model and stats out of the header line.
    pub fn short_mode(value: &str) -> Option<String> {
        (value == "bypassPermissions").then(|| "Bypass".to_string())
    }

    /// The line only opens the controls once there is something to change.
    pub fn is_available(&self) -> bool {
        self.model.is_some() || self.mode.is_some()
    }

    pub fn stats(&self) -> Option<String> {
        let parts: Vec<&str> = [self.percent.as_deref(), self.cost.as_deref()]
            .into_iter()
            .flatten()
            .collect();
        (!parts.is_empty()).then(|| parts.join(" \u{00B7} "))
    }

    pub fn spoken(&self) -> String {
        let mut parts = Vec::new();
        if let Some(m) = &self.model {
            parts.push(format!("Model {m}"));
        }
        if let Some(m) = &self.mode {
            parts.push(format!("Mode {m}"));
        }
        if let Some(p) = &self.percent {
            parts.push(format!("Context {p} used"));
        }
        if let Some(c) = &self.cost {
            parts.push(format!("Cost {c}"));
        }
        parts.join(", ")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerAction {
    Send,
    Stop,
}

/// While the agent works an empty draft stops it and anything typed queues behind it.
pub fn composer_action(working: bool, has_content: bool) -> ComposerAction {
    if working && !has_content {
        ComposerAction::Stop
    } else {
        ComposerAction::Send
    }
}

/// Text or at least one encoded image, and nothing still being encoded.
pub fn can_send(text: &str, ready_images: usize, encoding: usize, session_can_send: bool) -> bool {
    if !session_can_send || encoding != 0 {
        return false;
    }
    ready_images > 0 || !text.trim().is_empty()
}

pub const MAX_IMAGES: usize = 4;

pub fn image_label(count: usize) -> String {
    if count == 1 {
        "1 image".to_string()
    } else {
        format!("{count} images")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuickCommand {
    Compact,
    Context,
}

impl QuickCommand {
    pub const ALL: [QuickCommand; 2] = [Self::Compact, Self::Context];

    fn raw(self) -> &'static str {
        match self {
            Self::Compact => "compact",
            Self::Context => "context",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Compact => "Compact",
            Self::Context => "Context",
        }
    }

    pub fn detail(self) -> &'static str {
        match self {
            Self::Compact => "Summarise the conversation to free context",
            Self::Context => "Show what is using the context window",
        }
    }

    pub fn text(self) -> String {
        format!("/{}", self.raw())
    }

    /// Shown unless the agent listed its commands and this one is not among them.
    pub fn is_offered(self, commands: &[Command]) -> bool {
        commands.is_empty() || commands.iter().any(|c| c.name == self.raw())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionRole {
    Primary,
    Secondary,
    Destructive,
}

impl PermissionRole {
    pub fn from_kind(kind: &str) -> Self {
        match kind {
            "allow_once" => Self::Primary,
            "reject_once" | "reject_always" => Self::Destructive,
            _ => Self::Secondary,
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Primary => 0,
            Self::Secondary => 1,
            Self::Destructive => 2,
        }
    }
}

/// Allow once first, then the broader allows, reject last.
pub fn ordered_options(options: &[PermissionOption]) -> Vec<(PermissionOption, PermissionRole)> {
    let mut all: Vec<(PermissionOption, PermissionRole)> = options
        .iter()
        .map(|o| (o.clone(), PermissionRole::from_kind(&o.kind)))
        .collect();
    all.sort_by_key(|(_, role)| role.rank());
    all
}

/// The three slots of the permission card: the one-off allow, the deny, and any broader allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionSlots {
    pub allow: Option<PermissionOption>,
    pub deny: Option<PermissionOption>,
    pub extras: Vec<PermissionOption>,
}

pub fn permission_slots(options: &[PermissionOption]) -> PermissionSlots {
    let ordered = ordered_options(options);
    let allow = ordered
        .iter()
        .find(|(_, r)| *r == PermissionRole::Primary)
        .map(|(o, _)| o.clone());
    let deny = ordered
        .iter()
        .find(|(_, r)| *r == PermissionRole::Destructive)
        .map(|(o, _)| o.clone());
    let extras = ordered
        .into_iter()
        .map(|(o, _)| o)
        .filter(|o| {
            Some(&o.option_id) != allow.as_ref().map(|a| &a.option_id)
                && Some(&o.option_id) != deny.as_ref().map(|d| &d.option_id)
        })
        .collect();
    PermissionSlots {
        allow,
        deny,
        extras,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionLayout {
    pub primary: Option<PermissionOption>,
    pub reject: Option<PermissionOption>,
    /// Every other option, in the order the card offers them.
    pub more: Vec<PermissionOption>,
    /// More than three options: the primary allow and the reject stay visible, the rest sit behind a disclosure.
    pub collapsed: bool,
}

pub fn permission_layout(options: &[PermissionOption]) -> PermissionLayout {
    let ordered = ordered_options(options);
    let primary = ordered
        .iter()
        .find(|(_, r)| *r == PermissionRole::Primary)
        .or_else(|| {
            ordered
                .iter()
                .find(|(_, r)| *r == PermissionRole::Secondary)
        })
        .map(|(o, _)| o.clone());
    let reject = ordered
        .iter()
        .find(|(_, r)| *r == PermissionRole::Destructive)
        .map(|(o, _)| o.clone());
    let more = ordered
        .into_iter()
        .map(|(o, _)| o)
        .filter(|o| {
            Some(&o.option_id) != primary.as_ref().map(|p| &p.option_id)
                && Some(&o.option_id) != reject.as_ref().map(|r| &r.option_id)
        })
        .collect();
    PermissionLayout {
        primary,
        reject,
        more,
        collapsed: options.len() > 3,
    }
}

/// A message the agent never received, as it is kept across the chat being closed. Image bytes
/// are never stored; only how many went with the message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedFailed {
    pub id: Uuid,
    pub text: String,
    pub image_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failed {
    pub id: Uuid,
    pub text: String,
    /// Kept in memory only, so a retry in this session can send them again.
    pub images: Vec<ImageAttachment>,
    /// Images that went with the message but were not kept across a restart.
    pub images_lost: usize,
}

impl Failed {
    pub fn image_count(&self) -> usize {
        self.images.len() + self.images_lost
    }

    pub fn images_not_kept(&self) -> bool {
        self.images_lost > 0
    }

    /// A message that was only images has nothing left to send once they are gone.
    pub fn can_retry(&self) -> bool {
        !self.text.is_empty() || !self.images.is_empty()
    }
}

/// Messages the agent never received. Delivered ones live in the transcript; these stay visible
/// with Retry and Discard rather than vanishing, and survive the chat being closed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outbox {
    failed: Vec<Failed>,
}

impl Outbox {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn restoring(messages: &[PersistedFailed]) -> Self {
        Self {
            failed: messages
                .iter()
                .map(|m| Failed {
                    id: m.id,
                    text: m.text.clone(),
                    images: Vec::new(),
                    images_lost: m.image_count,
                })
                .collect(),
        }
    }

    pub fn failed(&self) -> &[Failed] {
        &self.failed
    }

    pub fn persisted(&self) -> Vec<PersistedFailed> {
        self.failed
            .iter()
            .map(|f| PersistedFailed {
                id: f.id,
                text: f.text.clone(),
                image_count: f.image_count(),
            })
            .collect()
    }

    pub fn record_failure(
        &mut self,
        text: &str,
        images: Vec<ImageAttachment>,
        images_lost: usize,
        id: Option<Uuid>,
    ) -> Failed {
        let entry = Failed {
            id: id.unwrap_or_else(Uuid::new_v4),
            text: text.to_string(),
            images,
            images_lost,
        };
        self.failed.push(entry.clone());
        entry
    }

    pub fn text_for(&self, id: Uuid) -> Option<&str> {
        self.entry_for(id).map(|f| f.text.as_str())
    }

    pub fn entry_for(&self, id: Uuid) -> Option<&Failed> {
        self.failed.iter().find(|f| f.id == id)
    }

    pub fn discard(&mut self, id: Uuid) {
        self.failed.retain(|f| f.id != id);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Connecting,
    CatchingUp,
    Live,
    Lost,
    /// The host's own word that the agent is gone for good; `Lost` is only a dropped connection.
    Ended,
}

/// How long the replay must stay quiet before the transcript is trusted.
pub const SETTLE_WINDOW: Duration = Duration::from_millis(400);

/// Tracks the replay window after a (re)connect. The holder replays its whole log, so the
/// transcript is only trustworthy once no new state has arrived for `SETTLE_WINDOW`. Times are
/// durations since any fixed start the caller keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTracker {
    phase: Phase,
    last_activity: Option<Duration>,
}

impl Default for LinkTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl LinkTracker {
    pub fn new() -> Self {
        Self {
            phase: Phase::Connecting,
            last_activity: None,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn allows_interaction(&self) -> bool {
        self.phase == Phase::Live
    }

    pub fn dial_started(&mut self) {
        self.phase = Phase::Connecting;
    }

    pub fn dial_failed(&mut self) {
        self.phase = Phase::Lost;
    }

    pub fn connection_lost(&mut self) {
        if self.phase != Phase::Ended {
            self.phase = Phase::Lost;
        }
    }

    pub fn ended(&mut self) {
        self.phase = Phase::Ended;
    }

    pub fn dial_succeeded(&mut self, now: Duration) {
        self.phase = Phase::CatchingUp;
        self.last_activity = Some(now);
    }

    pub fn activity(&mut self, now: Duration) {
        if self.phase == Phase::CatchingUp {
            self.last_activity = Some(now);
        }
    }

    /// True when this call moved the link from catching up to live.
    pub fn settle_if_quiet(&mut self, now: Duration) -> bool {
        let Some(last) = self.last_activity else {
            return false;
        };
        if self.phase != Phase::CatchingUp || now.saturating_sub(last) < SETTLE_WINDOW {
            return false;
        }
        self.phase = Phase::Live;
        true
    }
}

pub fn should_reconnect(phase: Phase, dial_in_flight: bool, left: bool) -> bool {
    phase == Phase::Lost && !dial_in_flight && !left
}

/// When a stored snapshot may be resumed, and what a lost stream means afterwards.
pub struct Resume;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attempt {
    pub offset: usize,
    pub identity: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterLoss {
    /// The resume did not take: drop the snapshot and replay from zero.
    ReplayFromZero,
    Ended,
    Lost,
}

impl Resume {
    pub fn identity_of(summary: &ChatSummary) -> i64 {
        summary.created
    }

    /// Any doubt returns None, which means a clean replay from zero.
    pub fn usable<'a>(
        snapshot: Option<&'a Snapshot>,
        journal: &Journal,
        summary: Option<&ChatSummary>,
    ) -> Option<&'a Snapshot> {
        let (snapshot, summary) = (snapshot?, summary?);
        if snapshot.offset > 0
            && snapshot.identity == Self::identity_of(summary)
            && snapshot.offset <= summary.log_bytes
            && snapshot.is_consistent(journal)
        {
            Some(snapshot)
        } else {
            None
        }
    }

    /// `summary` is the host's view after the loss, None when it could not be read. A resume
    /// that got nothing and ended is only trusted as "nothing new" when the host's log still
    /// reaches the offset (the daemon drops an attach whose `--from` is past its log).
    pub fn after_loss(
        attempt: Option<Attempt>,
        received_bytes: usize,
        failed_decoding: bool,
        summary: Option<&ChatSummary>,
    ) -> AfterLoss {
        if let Some(attempt) = attempt {
            if failed_decoding {
                return AfterLoss::ReplayFromZero;
            }
            if received_bytes <= attempt.offset
                && let Some(summary) = summary
                && (Self::identity_of(summary) != attempt.identity
                    || summary.log_bytes < attempt.offset)
            {
                return AfterLoss::ReplayFromZero;
            }
        }
        if summary.is_some_and(|s| !s.is_running) {
            AfterLoss::Ended
        } else {
            AfterLoss::Lost
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::fixture;
    use crate::acp::journal::TranscriptBuilder;
    use crate::acp::message::ConfigChoice;
    use crate::acp::message::ConfigOption;

    fn opt(id: &str, kind: &str) -> PermissionOption {
        PermissionOption {
            option_id: id.into(),
            name: id.into(),
            kind: kind.into(),
        }
    }

    fn ids(options: &[PermissionOption]) -> Vec<&str> {
        options.iter().map(|o| o.option_id.as_str()).collect()
    }

    #[test]
    fn titles_fall_back_for_home_and_root() {
        assert_eq!(folder_name("/home/sam/site/"), "site");
        assert_eq!(folder_name("/"), "/");
        assert_eq!(folder_name(""), "Home");
    }

    #[test]
    fn parent_path_and_agent_label_for_a_chat_row() {
        assert_eq!(
            parent_path("/home/dev/projects/api").as_deref(),
            Some("/home/dev/projects")
        );
        assert_eq!(parent_path("/srv").as_deref(), Some("/"));
        assert_eq!(parent_path("~/work/api").as_deref(), Some("~/work"));
        assert_eq!(parent_path("~"), None);
        assert_eq!(parent_path("/"), None);
        assert_eq!(
            agent_label("npx -y @agentclientprotocol/claude-agent-acp"),
            Some("Claude")
        );
        assert_eq!(agent_label("codex-acp"), Some("Codex"));
        assert_eq!(agent_label("npx -y something"), None);
    }

    #[test]
    fn context_summary_and_counts() {
        assert_eq!(compact_count(950), "950");
        assert_eq!(compact_count(31_043), "31k");
        assert_eq!(compact_count(1_000_000), "1M");
        assert_eq!(compact_count(1_500_000), "1.5M");
        assert_eq!(
            context_summary(Some(31_043), Some(1_000_000)).as_deref(),
            Some("31k / 1M \u{00B7} 3%")
        );
        assert_eq!(context_summary(None, Some(10)), None);
        assert_eq!(context_summary(Some(1), Some(0)), None);
    }

    #[test]
    fn context_fraction_is_clamped_and_needs_a_size() {
        assert_eq!(context_fraction(Some(250), Some(1000)), Some(0.25));
        assert_eq!(context_fraction(Some(2000), Some(1000)), Some(1.0));
        assert_eq!(context_fraction(Some(5), Some(0)), None);
        assert_eq!(context_fraction(None, Some(10)), None);
    }

    #[test]
    fn relative_paths_only_drop_the_folder_prefix() {
        assert_eq!(relative_path("/work/p/src/a.ts", "/work/p"), "src/a.ts");
        assert_eq!(
            relative_path("/work/other/a.ts", "/work/p"),
            "/work/other/a.ts"
        );
        assert_eq!(relative_path("/work/pp/a.ts", "/work/p"), "/work/pp/a.ts");
    }

    fn money(amount: f64, currency: &str) -> String {
        cost(&Cost {
            amount,
            currency: currency.into(),
        })
    }

    #[test]
    fn cost_format() {
        assert_eq!(money(0.157, "USD"), "$0.16");
        assert_eq!(money(0.0, "USD"), "$0.00");
        assert_eq!(money(1.24, "USD"), "$1.2");
        assert_eq!(money(12.5, "USD"), "$12.5");
        assert_eq!(money(0.5, "eur"), "0.50 EUR");
    }

    #[test]
    fn context_percent_rounds_and_needs_a_size() {
        assert_eq!(
            context_percent(Some(20_000), Some(1_000_000)).as_deref(),
            Some("2%")
        );
        assert_eq!(
            context_percent(Some(5_000_000), Some(1_000_000)).as_deref(),
            Some("100%")
        );
        assert_eq!(context_percent(None, Some(100)), None);
        assert_eq!(context_percent(Some(10), Some(0)), None);
    }

    #[test]
    fn mode_tint() {
        assert_eq!(ModeTint::from_mode(Some("plan")), ModeTint::Accent);
        assert_eq!(ModeTint::from_mode(Some("acceptEdits")), ModeTint::Success);
        assert_eq!(ModeTint::from_mode(Some("auto")), ModeTint::Secondary);
        assert_eq!(ModeTint::from_mode(Some("default")), ModeTint::Secondary);
        assert_eq!(
            ModeTint::from_mode(Some("bypassPermissions")),
            ModeTint::Danger
        );
        assert_eq!(ModeTint::from_mode(None), ModeTint::Secondary);
    }

    fn controls_state(mode: &str) -> ChatState {
        let choice = |v: &str, n: &str| ConfigChoice {
            value: v.into(),
            name: n.into(),
            description: String::new(),
        };
        let mut state = ChatState::default();
        state.config_options = vec![
            ConfigOption {
                id: "mode".into(),
                name: "Mode".into(),
                description: String::new(),
                category: Some("mode".into()),
                current_value: mode.into(),
                choices: vec![
                    choice("default", "Manual"),
                    choice("plan", "Plan"),
                    choice("bypassPermissions", "Bypass permissions"),
                ],
            },
            ConfigOption {
                id: "model".into(),
                name: "Model".into(),
                description: String::new(),
                category: Some("model".into()),
                current_value: "opus".into(),
                choices: vec![choice("opus", "Opus 5")],
            },
        ];
        state
    }

    #[test]
    fn status_line_is_empty_without_options() {
        let line = StatusLine::new(&ChatState::default());
        assert!(!line.is_available());
        assert_eq!(line.stats(), None);
        assert_eq!(line.spoken(), "");
    }

    #[test]
    fn status_line_composition_hides_missing_pieces() {
        let mut current = controls_state("plan");
        let line = StatusLine::new(&current);
        assert!(line.is_available());
        assert_eq!(line.model.as_deref(), Some("Opus 5"));
        assert_eq!(line.mode.as_deref(), Some("Plan"));
        assert_eq!(line.tint, ModeTint::Accent);
        assert_eq!(line.stats(), None);
        current.context_used = Some(20_000);
        current.context_size = Some(1_000_000);
        assert_eq!(StatusLine::new(&current).stats().as_deref(), Some("2%"));
        current.cost = Some(Cost {
            amount: 0.16,
            currency: "USD".into(),
        });
        let line = StatusLine::new(&current);
        assert_eq!(line.stats().as_deref(), Some("2% \u{00B7} $0.16"));
        assert_eq!(
            line.spoken(),
            "Model Opus 5, Mode Plan, Context 2% used, Cost $0.16"
        );
        current.context_size = None;
        assert_eq!(StatusLine::new(&current).stats().as_deref(), Some("$0.16"));
        assert_eq!(
            StatusLine::new(&controls_state("bypassPermissions"))
                .mode
                .as_deref(),
            Some("Bypass")
        );
    }

    #[test]
    fn status_line_falls_back_to_the_usage_model_id() {
        let mut current = ChatState::default();
        current.model_id = Some("some-model".into());
        let line = StatusLine::new(&current);
        assert_eq!(line.model.as_deref(), Some("some-model"));
        assert!(line.is_available());
    }

    #[test]
    fn send_rule() {
        assert!(can_send("hi", 0, 0, true));
        assert!(!can_send("  \n", 0, 0, true));
        assert!(can_send("", 1, 0, true));
        assert!(!can_send("hi", 1, 1, true));
        assert!(!can_send("hi", 0, 0, false));
    }

    #[test]
    fn the_composer_stops_only_when_working_with_nothing_typed() {
        assert_eq!(composer_action(true, false), ComposerAction::Stop);
        assert_eq!(composer_action(true, true), ComposerAction::Send);
        assert_eq!(composer_action(false, false), ComposerAction::Send);
        assert_eq!(MAX_IMAGES, 4);
    }

    #[test]
    fn image_labels() {
        assert_eq!(image_label(1), "1 image");
        assert_eq!(image_label(3), "3 images");
    }

    #[test]
    fn quick_commands_follow_the_agent_list() {
        assert!(QuickCommand::Compact.is_offered(&[]));
        let listed = [Command {
            name: "context".into(),
            description: String::new(),
            hint: None,
        }];
        assert!(!QuickCommand::Compact.is_offered(&listed));
        assert!(QuickCommand::Context.is_offered(&listed));
        assert_eq!(QuickCommand::Compact.text(), "/compact");
        assert_eq!(QuickCommand::Compact.title(), "Compact");
        assert_eq!(QuickCommand::ALL.len(), 2);
    }

    #[test]
    fn permission_options_order_allow_then_always_then_reject() {
        let options = [
            opt("r", "reject_once"),
            opt("a", "allow_always"),
            opt("o", "allow_once"),
            opt("x", "reject_always"),
        ];
        let ordered = ordered_options(&options);
        let got: Vec<_> = ordered.iter().map(|(o, _)| o.option_id.as_str()).collect();
        assert_eq!(got, ["o", "a", "r", "x"]);
        let roles: Vec<_> = ordered.iter().map(|(_, r)| *r).collect();
        assert_eq!(
            roles,
            [
                PermissionRole::Primary,
                PermissionRole::Secondary,
                PermissionRole::Destructive,
                PermissionRole::Destructive
            ]
        );
    }

    #[test]
    fn permission_slots_split_allow_deny_and_broader_allows() {
        let options = [
            opt("always", "allow_always"),
            opt("no", "reject_once"),
            opt("once", "allow_once"),
        ];
        let slots = permission_slots(&options);
        assert_eq!(slots.allow.unwrap().option_id, "once");
        assert_eq!(slots.deny.unwrap().option_id, "no");
        assert_eq!(ids(&slots.extras), ["always"]);
    }

    #[test]
    fn the_plan_approval_shows_the_first_allow_and_the_reject_and_hides_the_rest() {
        let options = [
            opt("default", "allow_once"),
            opt("acceptEdits", "allow_always"),
            opt("auto", "allow_always"),
            opt("bypass", "allow_always"),
            opt("plan", "reject_once"),
        ];
        let layout = permission_layout(&options);
        assert_eq!(layout.primary.unwrap().option_id, "default");
        assert_eq!(layout.reject.unwrap().option_id, "plan");
        assert_eq!(ids(&layout.more), ["acceptEdits", "auto", "bypass"]);
        assert!(layout.collapsed);
    }

    #[test]
    fn three_options_or_fewer_are_never_collapsed() {
        let layout = permission_layout(&[
            opt("a", "allow_once"),
            opt("b", "allow_always"),
            opt("c", "reject_once"),
        ]);
        assert!(!layout.collapsed);
        assert_eq!(ids(&layout.more), ["b"]);
    }

    #[test]
    fn without_an_allow_once_the_first_other_allow_is_primary() {
        let layout = permission_layout(&[opt("x", "allow_always"), opt("n", "reject_once")]);
        assert_eq!(layout.primary.unwrap().option_id, "x");
        assert!(layout.more.is_empty());
    }

    #[test]
    fn a_second_reject_goes_to_more_and_the_plan_shape_decodes() {
        let layout = permission_layout(&[
            opt("a", "allow_once"),
            opt("n1", "reject_once"),
            opt("n2", "reject_always"),
        ]);
        assert_eq!(layout.reject.unwrap().option_id, "n1");
        assert_eq!(ids(&layout.more), ["n2"]);

        let frame = r###"{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"s","toolCall":{"toolCallId":"t","title":"Approve Plan","kind":"switch_mode","status":"pending","content":[{"type":"content","content":{"type":"text","text":"## Plan\n1. one"}}]},"options":[{"optionId":"a","name":"Yes","kind":"allow_once"},{"optionId":"n","name":"No","kind":"reject_once"}]}}"###;
        let mut builder = TranscriptBuilder::new(&Journal::default(), None);
        builder.feed(format!("{frame}\n").as_bytes()).unwrap();
        let state = builder.state();
        let permission = state.pending_permissions()[0];
        assert_eq!(permission.kind, crate::acp::message::ToolKind::SwitchMode);
        assert_eq!(permission.text.as_deref(), Some("## Plan\n1. one"));
        assert_eq!(permission.title, "Approve Plan");
    }

    #[test]
    fn outbox_keeps_failed_messages_until_discarded() {
        let mut outbox = Outbox::new();
        let first = outbox.record_failure("one", vec![], 0, None);
        let second = outbox.record_failure("two", vec![], 0, None);
        let texts: Vec<_> = outbox.failed().iter().map(|f| f.text.as_str()).collect();
        assert_eq!(texts, ["one", "two"]);
        assert_eq!(outbox.text_for(second.id), Some("two"));
        outbox.discard(first.id);
        assert_eq!(outbox.failed().len(), 1);
        assert_eq!(outbox.text_for(first.id), None);
    }

    #[test]
    fn restored_messages_keep_their_text_and_only_count_their_images() {
        let id = Uuid::new_v4();
        let outbox = Outbox::restoring(&[
            PersistedFailed {
                id,
                text: "hello".into(),
                image_count: 2,
            },
            PersistedFailed {
                id: Uuid::new_v4(),
                text: String::new(),
                image_count: 1,
            },
        ]);
        assert_eq!(outbox.failed().len(), 2);
        assert_eq!(outbox.failed()[0].text, "hello");
        assert!(outbox.failed()[0].images_not_kept());
        assert!(outbox.failed()[0].can_retry());
        assert!(
            !outbox.failed()[1].can_retry(),
            "an images-only message has nothing left to send"
        );
        assert_eq!(
            outbox.persisted()[0],
            PersistedFailed {
                id,
                text: "hello".into(),
                image_count: 2
            }
        );

        let mut fresh = Outbox::new();
        fresh.record_failure(
            "with pics",
            vec![ImageAttachment {
                mime_type: "image/jpeg".into(),
                data: "AAAA".into(),
            }],
            0,
            None,
        );
        assert!(!fresh.failed()[0].images_not_kept());
        assert_eq!(fresh.persisted()[0].image_count, 1);
    }

    #[test]
    fn the_link_is_interactive_only_after_the_replay_goes_quiet() {
        let s = Duration::from_secs_f64;
        let mut link = LinkTracker::new();
        let start = s(1000.0);
        assert!(!link.allows_interaction());
        link.dial_succeeded(start);
        assert_eq!(link.phase(), Phase::CatchingUp);
        assert!(!link.settle_if_quiet(start + s(0.39)));
        link.activity(start + s(0.39));
        assert!(!link.settle_if_quiet(start + s(0.7)));
        assert!(link.settle_if_quiet(start + s(0.8)));
        assert!(link.allows_interaction());
        link.activity(start + s(5.0));
        assert_eq!(link.phase(), Phase::Live);
        link.connection_lost();
        assert!(!link.allows_interaction());
        assert!(!link.settle_if_quiet(start + s(9.0)));
    }

    #[test]
    fn an_ended_link_stays_ended_through_a_lost_connection() {
        let mut link = LinkTracker::new();
        link.ended();
        link.connection_lost();
        assert_eq!(link.phase(), Phase::Ended);
        link.dial_failed();
        assert_eq!(link.phase(), Phase::Lost);
    }

    #[test]
    fn reconnect_only_when_lost_and_not_already_dialing() {
        assert!(should_reconnect(Phase::Lost, false, false));
        assert!(!should_reconnect(Phase::Lost, true, false));
        assert!(!should_reconnect(Phase::Lost, false, true));
        for phase in [Phase::Connecting, Phase::CatchingUp, Phase::Live] {
            assert!(!should_reconnect(phase, false, false));
        }
    }

    // Resume

    const IDENTITY: i64 = 1_700_000_000;

    fn summary(bytes: usize, created: i64, running: bool) -> ChatSummary {
        ChatSummary {
            log_bytes: bytes,
            created,
            is_running: running,
            ..ChatSummary::new("c", "/x")
        }
    }

    fn snapshot_after(count: usize) -> (Snapshot, Journal) {
        let cut = fixture::TURN.offset_after(count);
        let mut seen = fixture::turn_journal();
        seen.entries = seen.entries_up_to(cut).into_iter().cloned().collect();
        let mut builder = TranscriptBuilder::new(&seen, None);
        builder.feed(&fixture::TURN.log(Some(count))).unwrap();
        (
            Snapshot::new(IDENTITY, cut, &seen, builder.state().clone()),
            seen,
        )
    }

    #[test]
    fn resume_is_only_trusted_when_the_host_agrees() {
        let count = fixture::TURN.agent_lines().len();
        let (taken, _) = snapshot_after(count);
        let journal = fixture::turn_journal();
        let usable = |s: Option<&Snapshot>, sum: Option<&ChatSummary>| {
            Resume::usable(s, &journal, sum).is_some()
        };
        assert!(usable(
            Some(&taken),
            Some(&summary(taken.offset, IDENTITY, true))
        ));
        assert!(usable(
            Some(&taken),
            Some(&summary(taken.offset + 50, IDENTITY, true))
        ));
        assert!(!usable(
            Some(&taken),
            Some(&summary(taken.offset - 1, IDENTITY, true))
        ));
        assert!(!usable(Some(&taken), Some(&summary(taken.offset, 5, true))));
        assert!(!usable(Some(&taken), None));
        assert!(!usable(None, Some(&summary(9, IDENTITY, true))));
    }

    #[test]
    fn after_a_loss_the_host_decides_between_replay_ended_and_dropped() {
        let sum = |bytes, created, running| summary(bytes, created, running);
        let attempt = Some(Attempt {
            offset: 500,
            identity: 100,
        });
        let outcome = |attempt, received, failed, summary: Option<&ChatSummary>| {
            Resume::after_loss(attempt, received, failed, summary)
        };
        assert_eq!(
            outcome(attempt, 500, false, Some(&sum(200, 100, true))),
            AfterLoss::ReplayFromZero
        );
        assert_eq!(
            outcome(attempt, 500, false, Some(&sum(900, 7, true))),
            AfterLoss::ReplayFromZero
        );
        assert_eq!(
            outcome(attempt, 900, true, Some(&sum(900, 100, true))),
            AfterLoss::ReplayFromZero
        );
        assert_eq!(
            outcome(attempt, 500, false, Some(&sum(500, 100, false))),
            AfterLoss::Ended
        );
        assert_eq!(
            outcome(attempt, 700, false, Some(&sum(700, 100, false))),
            AfterLoss::Ended
        );
        assert_eq!(
            outcome(attempt, 500, false, Some(&sum(800, 100, true))),
            AfterLoss::Lost
        );
        assert_eq!(outcome(attempt, 500, false, None), AfterLoss::Lost);
        assert_eq!(
            outcome(None, 0, false, Some(&sum(0, 100, true))),
            AfterLoss::Lost
        );
        assert_eq!(
            outcome(None, 0, false, Some(&sum(10, 100, false))),
            AfterLoss::Ended
        );
    }
}
