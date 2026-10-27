//! The model, effort and mode a user last chose become the start values of the chats this
//! device begins itself. Pure rules: what is remembered, and which option a new session sets next.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::message::ConfigOption;

/// The key for the agent the chats spawn today (`host::ADAPTER_PACKAGE`).
pub const AGENT_CLAUDE: &str = "claude";

/// The remembered options, in the order a new session applies them: the model comes first
/// because the effort levels on offer depend on it.
pub const REMEMBERED: [&str; 3] = ["model", "effort", "mode"];

/// `{agent: {option id: value}}`, as stored in `preferences.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChatDefaults(BTreeMap<String, BTreeMap<String, String>>);

impl ChatDefaults {
    /// A confirmed change the user made. False when nothing changed, or when the option is not one
    /// that is remembered.
    pub fn remember(&mut self, agent: &str, id: &str, value: &str) -> bool {
        if !REMEMBERED.contains(&id) {
            return false;
        }
        let stored = self.0.entry(agent.to_string()).or_default();
        if stored.get(id).is_some_and(|v| v == value) {
            return false;
        }
        stored.insert(id.to_string(), value.to_string());
        true
    }

    pub fn get(&self, agent: &str, id: &str) -> Option<&str> {
        self.0.get(agent)?.get(id).map(String::as_str)
    }

    /// The next `set_config_option` a session that was just started here needs, given the options
    /// its last answer offered. `tried` holds the ids already attempted for this session, so a
    /// refused value is not asked again. A stored value is skipped when the option is missing, the
    /// value is not one of its choices, or it is already the current one.
    pub fn next_apply(
        &self,
        agent: &str,
        options: &[ConfigOption],
        tried: &[String],
    ) -> Option<(String, String)> {
        REMEMBERED.iter().find_map(|id| {
            if tried.iter().any(|t| t == id) {
                return None;
            }
            let value = self.get(agent, id)?;
            let option = options.iter().find(|o| o.id == *id)?;
            let offered = option.choices.iter().any(|c| c.value == value);
            (offered && option.current_value != value).then(|| (id.to_string(), value.to_string()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::message::ConfigChoice;

    fn option(id: &str, current: &str, values: &[&str]) -> ConfigOption {
        ConfigOption {
            id: id.into(),
            name: id.into(),
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

    fn offered() -> Vec<ConfigOption> {
        vec![
            option("mode", "default", &["default", "plan"]),
            option("model", "default", &["default", "opus", "sonnet"]),
            option("effort", "medium", &["low", "medium", "high"]),
            option("agent", "a", &["a", "b"]),
        ]
    }

    #[test]
    fn only_the_three_options_are_remembered_and_only_when_they_change() {
        let mut d = ChatDefaults::default();
        assert!(d.remember(AGENT_CLAUDE, "model", "opus"));
        assert!(!d.remember(AGENT_CLAUDE, "model", "opus"));
        assert!(d.remember(AGENT_CLAUDE, "model", "sonnet"));
        assert!(d.remember(AGENT_CLAUDE, "effort", "high"));
        assert!(d.remember(AGENT_CLAUDE, "mode", "plan"));
        assert!(!d.remember(AGENT_CLAUDE, "agent", "b"));
        assert_eq!(d.get(AGENT_CLAUDE, "model"), Some("sonnet"));
        assert_eq!(d.get(AGENT_CLAUDE, "agent"), None);
        assert_eq!(d.get("other", "model"), None);
    }

    #[test]
    fn defaults_are_kept_per_agent() {
        let mut d = ChatDefaults::default();
        d.remember(AGENT_CLAUDE, "model", "opus");
        d.remember("other", "model", "haiku");
        assert_eq!(d.get(AGENT_CLAUDE, "model"), Some("opus"));
        assert_eq!(d.get("other", "model"), Some("haiku"));
    }

    #[test]
    fn a_new_session_applies_each_differing_offered_default_one_after_the_other() {
        let mut d = ChatDefaults::default();
        d.remember(AGENT_CLAUDE, "mode", "plan");
        d.remember(AGENT_CLAUDE, "effort", "high");
        d.remember(AGENT_CLAUDE, "model", "opus");
        let mut options = offered();
        let mut tried = Vec::new();
        let mut calls = Vec::new();
        while let Some((id, value)) = d.next_apply(AGENT_CLAUDE, &options, &tried) {
            options
                .iter_mut()
                .find(|o| o.id == id)
                .unwrap()
                .current_value = value.clone();
            tried.push(id.clone());
            calls.push((id, value));
        }
        let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(
            calls,
            vec![
                pair("model", "opus"),
                pair("effort", "high"),
                pair("mode", "plan")
            ]
        );
    }

    #[test]
    fn missing_options_unoffered_values_and_equal_values_are_skipped() {
        let mut d = ChatDefaults::default();
        d.remember(AGENT_CLAUDE, "model", "retired");
        d.remember(AGENT_CLAUDE, "effort", "medium");
        d.remember(AGENT_CLAUDE, "mode", "plan");
        let no_mode: Vec<_> = offered().into_iter().filter(|o| o.id != "mode").collect();
        assert_eq!(d.next_apply(AGENT_CLAUDE, &no_mode, &[]), None);
        assert_eq!(
            d.next_apply(AGENT_CLAUDE, &offered(), &[]),
            Some(("mode".into(), "plan".into()))
        );
        assert_eq!(d.next_apply("other", &offered(), &[]), None);
    }

    #[test]
    fn an_attempted_option_is_not_asked_again() {
        let mut d = ChatDefaults::default();
        d.remember(AGENT_CLAUDE, "model", "opus");
        assert!(d.next_apply(AGENT_CLAUDE, &offered(), &[]).is_some());
        assert_eq!(
            d.next_apply(AGENT_CLAUDE, &offered(), &["model".to_string()]),
            None
        );
    }

    #[test]
    fn the_stored_shape_is_a_plain_map() {
        let mut d = ChatDefaults::default();
        d.remember(AGENT_CLAUDE, "model", "opus");
        let json = serde_json::to_string(&d).unwrap();
        assert_eq!(json, r#"{"claude":{"model":"opus"}}"#);
        assert_eq!(serde_json::from_str::<ChatDefaults>(&json).unwrap(), d);
    }
}
