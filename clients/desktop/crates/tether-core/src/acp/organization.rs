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
    pub five_hour: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
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
