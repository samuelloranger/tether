//! User-owned chat metadata and explicit text-context branches. None of these operations change files.

use super::reducer::{Item, ItemKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub custom_title: String,
    #[serde(default)]
    pub project_root: String,
    #[serde(default)]
    pub parent: Option<Parent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Parent {
    pub name: String,
    pub title: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Branch {
    pub parent: Parent,
    pub context: String,
    pub draft: String,
}

/// Only text from before the selected user turn is copied. Reject images instead of silently
/// losing context. Bound the whole seed; truncating a transcript could reverse its meaning.
/// `inherited` is the seed of a chat that is itself a branch: its items never show it.
pub fn branch_before(
    items: &[Item],
    selected: i64,
    parent: Parent,
    inherited: &str,
) -> Result<Branch, &'static str> {
    let index = items
        .iter()
        .position(|i| i.id == selected)
        .ok_or("That message is no longer available.")?;
    let ItemKind::User {
        text, image_count, ..
    } = &items[index].kind
    else {
        return Err("Choose a user message to branch.");
    };
    if *image_count > 0 {
        return Err("This prompt has images. Create a new chat and attach the images again.");
    }
    let mut context = inherited.to_string();
    if context.len() > 128 * 1024 {
        return Err("Earlier context is too long to copy safely. Start a new chat with a summary.");
    }
    for item in &items[..index] {
        let (role, text) = match &item.kind {
            ItemKind::User {
                text, image_count, ..
            } if *image_count == 0 => ("User", text),
            ItemKind::User { .. } | ItemKind::Images { .. } => {
                return Err(
                    "Earlier messages contain images. Text-only branching cannot carry them over.",
                );
            }
            ItemKind::Assistant { text, .. } => ("Assistant", text),
            _ => continue,
        };
        context.push_str(&format!("\n{role}:\n{text}\n"));
        if context.len() > 128 * 1024 {
            return Err(
                "Earlier context is too long to copy safely. Start a new chat with a summary.",
            );
        }
    }
    Ok(Branch {
        parent,
        context,
        draft: text.clone(),
    })
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: f64,
    pub resets_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub active: Option<bool>,
    pub five_hour: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    pub monthly: Option<UsageWindow>,
    pub monthly_meter: Option<MonthlyMeter>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub stale: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct PlanUsage {
    #[serde(default)]
    pub claude: ProviderUsage,
    #[serde(default)]
    pub codex: ProviderUsage,
    #[serde(default)]
    pub opencode: ProviderUsage,
    #[serde(default)]
    pub copilot: ProviderUsage,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyMeter {
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub unit: String,
    #[serde(default)]
    pub unlimited: bool,
    #[serde(default)]
    pub resets_at: i64,
}

impl MonthlyMeter {
    fn number(value: f64) -> String {
        if value > 0.0 && value < 0.01 {
            return "<0.01".into();
        }
        format!("{value:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
    fn valid_count(value: Option<f64>) -> Option<f64> {
        value.filter(|v| v.is_finite() && *v >= 0.0)
    }
    pub fn percent(&self) -> Option<f32> {
        if self.unlimited {
            return None;
        }
        let used = Self::valid_count(self.used)?;
        let limit = Self::valid_count(self.limit).filter(|v| *v > 0.0)?;
        Some((used / limit * 100.0).clamp(0.0, 100.0) as f32)
    }
    pub fn value(&self) -> String {
        if self.unlimited {
            return "Unlimited".into();
        }
        if let Some(percent) = self.percent() {
            return format!("{percent:.0}%");
        }
        Self::valid_count(self.used)
            .map(|used| format!("{} {}", Self::number(used), self.unit))
            .unwrap_or_else(|| "—".into())
    }
    pub fn detail_value(&self) -> String {
        if self.unlimited {
            return "Unlimited".into();
        }
        let Some(used) = Self::valid_count(self.used) else {
            return "Usage unavailable".into();
        };
        if let Some(limit) = Self::valid_count(self.limit).filter(|v| *v > 0.0) {
            format!(
                "{} / {} {} used",
                Self::number(used),
                Self::number(limit),
                self.unit
            )
        } else {
            format!("{} {} used", Self::number(used), self.unit)
        }
    }
    pub fn reset_text(&self, now: i64) -> String {
        let reset = if self.resets_at > 0 {
            UsageWindow {
                used_percent: 0.0,
                resets_at: self.resets_at,
            }
            .reset_text(now)
        } else {
            "Reset time unavailable".into()
        };
        if self.unit == "credits" && self.limit.is_none() {
            format!("{reset} · Included allowance unavailable")
        } else {
            reset
        }
    }
}

impl ProviderUsage {
    pub fn is_active(&self) -> bool {
        self.active.unwrap_or_else(|| {
            [&self.five_hour, &self.weekly, &self.monthly]
                .into_iter()
                .any(|w| w.as_ref().is_some_and(UsageWindow::valid))
                || self.monthly_meter.is_some()
        })
    }

    pub fn is_stale(&self, now: i64, connected: bool) -> bool {
        self.stale
            || !connected
            || self.updated_at <= 0
            || now.saturating_sub(self.updated_at) >= 180
    }

    pub fn freshness(&self, now: i64, connected: bool) -> String {
        if self.updated_at <= 0 {
            return "Usage unavailable".into();
        }
        let minutes = now.saturating_sub(self.updated_at).max(0) / 60;
        if self.is_stale(now, connected) {
            format!("Updated {minutes}m ago · stale")
        } else if minutes == 0 {
            "Updated just now".into()
        } else {
            format!("Updated {minutes}m ago")
        }
    }
}

impl UsageWindow {
    pub fn valid(&self) -> bool {
        self.used_percent.is_finite()
            && (0.0..=100.0).contains(&self.used_percent)
            && self.resets_at > 0
    }
    pub fn reset_text(&self, now: i64) -> String {
        let seconds = self.resets_at.saturating_sub(now);
        if seconds <= 0 {
            return "Reset due · refresh pending".into();
        }
        let mins = (seconds + 59) / 60;
        if mins >= 1440 {
            format!("Resets in {}d {}h", mins / 1440, (mins % 1440) / 60)
        } else {
            format!("Resets in {}h {:02}m", mins / 60, mins % 60)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copilot_credit_meters_keep_counts_without_inventing_percentages() {
        let mut meter = MonthlyMeter {
            used: Some(0.25),
            unit: "credits".into(),
            ..Default::default()
        };
        assert_eq!(meter.value(), "0.25 credits");
        assert_eq!(meter.detail_value(), "0.25 credits used");
        assert_eq!(meter.percent(), None);
        assert!(
            meter
                .reset_text(1000)
                .contains("Included allowance unavailable")
        );
        meter.used = None;
        assert_eq!(meter.value(), "—");
        meter.unlimited = true;
        assert_eq!(meter.value(), "Unlimited");
        assert_eq!(meter.percent(), None);
        meter.unlimited = false;
        meter.used = Some(210.0);
        meter.limit = Some(300.0);
        meter.unit = "requests".into();
        assert_eq!(meter.percent(), Some(70.0));
        assert_eq!(meter.detail_value(), "210 / 300 requests used");
    }
    #[test]
    fn subscriptions_require_quota_evidence_and_explicit_inactive_overrides_cache() {
        let mut usage = ProviderUsage::default();
        assert!(!usage.is_active());
        usage.five_hour = Some(UsageWindow {
            used_percent: 0.0,
            resets_at: 2000,
        });
        usage.updated_at = 1000;
        assert!(usage.is_active());
        assert!(!usage.is_stale(1100, true));
        assert!(usage.is_stale(1100, false));
        usage.stale = true;
        assert!(usage.is_active());
        assert_eq!(usage.freshness(2200, true), "Updated 20m ago · stale");
        usage.active = Some(false);
        assert!(!usage.is_active());
    }

    #[test]
    fn go_monthly_limits_decode_without_breaking_legacy_usage() {
        let usage: PlanUsage = serde_json::from_str(r#"{"claude":{"fiveHour":{"usedPercent":0,"resetsAt":2000}},"opencode":{"active":true,"monthly":{"usedPercent":63,"resetsAt":3000}}}"#).unwrap();
        assert!(usage.claude.is_active());
        assert!(!usage.codex.is_active());
        assert!(usage.opencode.is_active());
        assert_eq!(usage.opencode.monthly.unwrap().used_percent, 63.0);
    }
    fn user(id: i64, text: &str) -> Item {
        Item {
            id,
            kind: ItemKind::User {
                text: text.into(),
                image_count: 0,
                offset: 0,
                images: vec![],
            },
        }
    }
    #[test]
    fn context_stops_before_selected_prompt_and_excludes_later_turns() {
        let b = branch_before(
            &[user(1, "before"), user(2, "selected"), user(3, "later")],
            2,
            Parent {
                name: "p".into(),
                title: "Parent".into(),
                method: "copy".into(),
            },
            "",
        )
        .unwrap();
        assert!(b.context.contains("before"));
        assert!(!b.context.contains("selected"));
        assert!(!b.context.contains("later"));
        assert_eq!(b.draft, "selected");
    }
    #[test]
    fn a_branch_of_a_branch_keeps_the_inherited_context_first() {
        let parent = Parent {
            name: "p".into(),
            title: "Parent".into(),
            method: "copy".into(),
        };
        let b = branch_before(
            &[user(1, "before"), user(2, "selected")],
            2,
            parent.clone(),
            "\nUser:\ngrandparent\n",
        )
        .unwrap();
        assert!(b.context.starts_with("\nUser:\ngrandparent\n"));
        assert!(b.context.contains("before"));
        let huge = "x".repeat(128 * 1024 + 1);
        assert!(branch_before(&[user(1, "selected")], 1, parent, &huge).is_err());
    }
    #[test]
    fn absent_windows_are_not_zero_and_expired_resets_are_not_negative() {
        let u: PlanUsage = serde_json::from_str(
            r#"{"claude":{"fiveHour":null,"weekly":{"usedPercent":42,"resetsAt":100}}}"#,
        )
        .unwrap();
        assert!(u.claude.five_hour.is_none());
        assert_eq!(
            u.claude.weekly.unwrap().reset_text(101),
            "Reset due · refresh pending"
        );
        assert!(u.codex.weekly.is_none());
    }
}
