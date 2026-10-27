//! The New chat dialog's Options row: what the chat will start with, from the user's stored
//! defaults for the agent and the choices the agent offered in its last session on this host.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::agent::{self, AgentProfile};
use super::defaults::ChatDefaults;
use super::message::ConfigOption;

/// What a chat started from the dialog sets once the agent has answered.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum StartOptions {
    /// The stored defaults, as a chat started without the Options row gets them.
    #[default]
    Stored,
    /// The agent's own defaults: nothing is applied.
    Reset,
    /// The dialog's values, over the stored ones. `changed` holds the ids the user moved off what
    /// the dialog was filled with: only those become the stored defaults.
    Picks {
        values: BTreeMap<String, String>,
        changed: Vec<String>,
    },
}

impl StartOptions {
    /// Whether the user's pick of `id` is theirs to keep as the default.
    pub fn is_chosen(&self, id: &str) -> bool {
        matches!(self, Self::Picks { changed, .. } if changed.iter().any(|c| c == id))
    }
}

/// The options each agent offered in its last session, per host, as the dialog's menus list them.
/// Stored in `preferences.json` as `{host: {agent: [option]}}`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OptionsCache(BTreeMap<String, BTreeMap<String, Vec<ConfigOption>>>);

impl OptionsCache {
    pub fn get(&self, host: &str, agent: &str) -> &[ConfigOption] {
        self.0
            .get(host)
            .and_then(|h| h.get(agent))
            .map_or(&[], Vec::as_slice)
    }

    /// Keeps the options the agent remembers, in the order they are applied. False when nothing
    /// changed or the session offered none of them.
    pub fn store(&mut self, host: &str, agent: &str, options: &[ConfigOption]) -> bool {
        let kept: Vec<ConfigOption> = agent::remembered_ids(agent)
            .iter()
            .filter_map(|id| options.iter().find(|o| o.id == *id))
            .cloned()
            .collect();
        if kept.is_empty() || self.get(host, agent) == kept.as_slice() {
            return false;
        }
        self.0
            .entry(host.to_string())
            .or_default()
            .insert(agent.to_string(), kept);
        true
    }
}

/// One menu of the opened Options row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionRow {
    pub id: String,
    pub name: String,
    /// `(value, name)`
    pub choices: Vec<(String, String)>,
    pub value: String,
    pub value_name: String,
    /// Differs from what the row was filled with: drawn with an accent edge.
    pub changed: bool,
}

/// The dialog's state for the picked agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionsDraft {
    label: &'static str,
    cached: Vec<ConfigOption>,
    base: BTreeMap<String, String>,
    values: BTreeMap<String, String>,
    reset: bool,
}

impl OptionsDraft {
    /// Filled with the stored default for each option the agent offers, else the value it had in
    /// its last session.
    pub fn new(agent: &AgentProfile, defaults: &ChatDefaults, cached: &[ConfigOption]) -> Self {
        let cached: Vec<ConfigOption> = agent
            .remembered
            .iter()
            .filter_map(|id| cached.iter().find(|o| o.id == *id))
            .cloned()
            .collect();
        let base: BTreeMap<String, String> = cached
            .iter()
            .map(|o| {
                let stored = defaults
                    .get(agent.key, &o.id)
                    .filter(|v| o.choices.iter().any(|c| c.value == *v));
                (
                    o.id.clone(),
                    stored.map_or_else(|| o.current_value.clone(), str::to_string),
                )
            })
            .collect();
        Self {
            label: agent.label,
            values: base.clone(),
            base,
            cached,
            reset: false,
        }
    }

    /// There are choices to show; before the agent's first chat on this host there are none.
    pub fn has_choices(&self) -> bool {
        !self.cached.is_empty()
    }

    pub fn is_reset(&self) -> bool {
        self.reset
    }

    pub fn rows(&self) -> Vec<OptionRow> {
        self.cached
            .iter()
            .map(|o| {
                let value = self.values.get(&o.id).cloned().unwrap_or_default();
                OptionRow {
                    id: o.id.clone(),
                    name: o.name.clone(),
                    choices: o
                        .choices
                        .iter()
                        .map(|c| (c.value.clone(), c.name.clone()))
                        .collect(),
                    value_name: name_of(o, &value),
                    changed: !self.reset && self.base.get(&o.id) != Some(&value),
                    value,
                }
            })
            .collect()
    }

    /// False for a value the option does not offer.
    pub fn pick(&mut self, id: &str, value: &str) -> bool {
        let offered = self
            .cached
            .iter()
            .any(|o| o.id == id && o.choices.iter().any(|c| c.value == value));
        if offered {
            self.values.insert(id.to_string(), value.to_string());
            self.reset = false;
        }
        offered
    }

    /// Back to the agent's own defaults: the menus show the values of its last session, and
    /// nothing is applied.
    pub fn reset(&mut self) {
        self.values = self
            .cached
            .iter()
            .map(|o| (o.id.clone(), o.current_value.clone()))
            .collect();
        self.base = self.values.clone();
        self.reset = true;
    }

    /// The folded row's line: what the chat starts with, e.g. `Opus · High · Auto`.
    pub fn summary(&self) -> String {
        if self.reset || self.cached.is_empty() {
            return format!("{}'s defaults", self.label);
        }
        self.cached
            .iter()
            .map(|o| name_of(o, self.values.get(&o.id).map_or("", String::as_str)))
            .collect::<Vec<_>>()
            .join(" \u{b7} ")
    }

    /// What the opened row says under the menus, or in place of them before there is a cache.
    pub fn note(&self) -> String {
        if self.cached.is_empty() {
            format!(
                "The choices appear after your first {0} chat on this host. Until then it starts on {0}'s own defaults.",
                self.label
            )
        } else if self.reset {
            format!("Starts on {}'s own defaults", self.label)
        } else {
            format!("From your last {} chat", self.label)
        }
    }

    pub fn start_options(&self) -> StartOptions {
        if self.reset {
            StartOptions::Reset
        } else if self.cached.is_empty() {
            StartOptions::Stored
        } else {
            StartOptions::Picks {
                values: self.values.clone(),
                changed: self
                    .rows()
                    .into_iter()
                    .filter(|r| r.changed)
                    .map(|r| r.id)
                    .collect(),
            }
        }
    }
}

fn name_of(option: &ConfigOption, value: &str) -> String {
    option
        .choices
        .iter()
        .find(|c| c.value == value)
        .map_or_else(|| value.to_string(), |c| c.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::agent::{CLAUDE, CODEX};
    use crate::acp::message::ConfigChoice;

    fn option(id: &str, current: &str, choices: &[(&str, &str)]) -> ConfigOption {
        ConfigOption {
            id: id.into(),
            name: id.to_uppercase(),
            description: String::new(),
            category: None,
            current_value: current.into(),
            choices: choices
                .iter()
                .map(|(v, n)| ConfigChoice {
                    value: (*v).into(),
                    name: (*n).into(),
                    description: String::new(),
                })
                .collect(),
        }
    }

    fn claude_options() -> Vec<ConfigOption> {
        vec![
            option("mode", "default", &[("default", "Ask"), ("plan", "Plan")]),
            option("model", "sonnet", &[("sonnet", "Sonnet"), ("opus", "Opus")]),
            option(
                "effort",
                "medium",
                &[("medium", "Medium"), ("high", "High")],
            ),
            option("other", "x", &[("x", "X")]),
        ]
    }

    #[test]
    fn rows_follow_the_apply_order_and_keep_only_remembered_options() {
        let draft = OptionsDraft::new(&CLAUDE, &ChatDefaults::default(), &claude_options());
        let ids: Vec<_> = draft.rows().iter().map(|r| r.id.clone()).collect();
        assert_eq!(ids, ["model", "effort", "mode"]);
    }

    #[test]
    fn the_prefill_is_the_stored_value_then_the_cached_current_value() {
        let mut stored = ChatDefaults::default();
        stored.remember("claude", "model", "opus");
        stored.remember("claude", "effort", "retired");
        let draft = OptionsDraft::new(&CLAUDE, &stored, &claude_options());
        let values: Vec<_> = draft.rows().iter().map(|r| r.value.clone()).collect();
        assert_eq!(values, ["opus", "medium", "default"]);
        assert!(draft.rows().iter().all(|r| !r.changed));
        assert_eq!(draft.summary(), "Opus \u{b7} Medium \u{b7} Ask");
    }

    #[test]
    fn no_cache_means_no_choices_a_note_and_the_stored_defaults() {
        let draft = OptionsDraft::new(&CODEX, &ChatDefaults::default(), &[]);
        assert!(!draft.has_choices());
        assert!(draft.rows().is_empty());
        assert_eq!(draft.summary(), "Codex's defaults");
        assert_eq!(
            draft.note(),
            "The choices appear after your first Codex chat on this host. Until then it starts on Codex's own defaults."
        );
        assert_eq!(draft.start_options(), StartOptions::Stored);
    }

    #[test]
    fn a_pick_marks_the_row_changed_and_goes_into_the_start_options() {
        let mut draft = OptionsDraft::new(&CLAUDE, &ChatDefaults::default(), &claude_options());
        assert!(draft.pick("effort", "high"));
        assert!(!draft.pick("effort", "nope"));
        assert!(!draft.pick("agent", "x"));
        let changed: Vec<_> = draft
            .rows()
            .iter()
            .filter(|r| r.changed)
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(changed, ["effort"]);
        assert_eq!(draft.summary(), "Sonnet \u{b7} High \u{b7} Ask");
        let start = draft.start_options();
        let StartOptions::Picks { values, .. } = &start else {
            panic!("picks");
        };
        assert_eq!(values.get("effort").map(String::as_str), Some("high"));
        assert_eq!(values.get("model").map(String::as_str), Some("sonnet"));
        assert!(start.is_chosen("effort"));
        assert!(!start.is_chosen("model"));
        assert!(!StartOptions::Stored.is_chosen("effort"));
    }

    #[test]
    fn reset_applies_nothing_and_a_later_pick_brings_the_picks_back() {
        let mut stored = ChatDefaults::default();
        stored.remember("claude", "model", "opus");
        let mut draft = OptionsDraft::new(&CLAUDE, &stored, &claude_options());
        draft.reset();
        assert!(draft.is_reset());
        assert_eq!(draft.summary(), "Claude's defaults");
        assert_eq!(draft.start_options(), StartOptions::Reset);
        assert_eq!(draft.rows()[0].value, "sonnet");
        assert!(draft.rows().iter().all(|r| !r.changed));
        assert!(draft.pick("mode", "plan"));
        assert!(!draft.is_reset());
        assert!(matches!(draft.start_options(), StartOptions::Picks { .. }));
    }

    #[test]
    fn after_a_reset_only_the_options_picked_count_as_changed() {
        let mut stored = ChatDefaults::default();
        stored.remember("claude", "effort", "high");
        let mut draft = OptionsDraft::new(&CLAUDE, &stored, &claude_options());
        draft.reset();
        assert!(draft.pick("model", "opus"));
        let StartOptions::Picks { changed, .. } = draft.start_options() else {
            panic!("picks");
        };
        assert_eq!(changed, ["model"]);
    }

    #[test]
    fn the_cache_keeps_the_remembered_options_per_host_and_agent() {
        let mut cache = OptionsCache::default();
        assert!(cache.get("h:22", "claude").is_empty());
        assert!(cache.store("h:22", "claude", &claude_options()));
        assert!(!cache.store("h:22", "claude", &claude_options()));
        let ids: Vec<_> = cache
            .get("h:22", "claude")
            .iter()
            .map(|o| o.id.clone())
            .collect();
        assert_eq!(ids, ["model", "effort", "mode"]);
        assert!(cache.get("h:22", "codex").is_empty());
        assert!(cache.get("other:22", "claude").is_empty());
        assert!(!cache.store("h:22", "codex", &claude_options()[3..]));
        let mut changed = claude_options();
        changed[1].current_value = "opus".into();
        assert!(cache.store("h:22", "claude", &changed));
        let json = serde_json::to_string(&cache).unwrap();
        assert_eq!(serde_json::from_str::<OptionsCache>(&json).unwrap(), cache);
    }
}
