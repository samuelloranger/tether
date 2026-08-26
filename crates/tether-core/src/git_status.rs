//! Pure port of `apps/mobile/src/gitStatusModel.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: String,
    pub short_sha: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
}

pub fn empty_repo_status() -> RepoStatus {
    RepoStatus {
        branch: String::new(),
        short_sha: String::new(),
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
    }
}

pub fn can_rewrite_head(status: &RepoStatus) -> bool {
    if status.short_sha.is_empty() && status.branch.is_empty() {
        return false;
    }
    status.upstream.is_none() || status.ahead >= 1
}

/// Show Push when there is something to send (ahead, or no upstream yet).
pub fn can_push_head(status: &RepoStatus) -> bool {
    if status.short_sha.is_empty() && status.branch.is_empty() {
        return false;
    }
    if status.detached {
        return false;
    }
    status.upstream.is_none() || status.ahead > 0
}

pub fn format_repo_status_label(status: &RepoStatus) -> Option<String> {
    if status.branch.is_empty() && status.short_sha.is_empty() {
        return None;
    }
    if status.detached {
        let sha = if status.short_sha.is_empty() {
            "unknown"
        } else {
            status.short_sha.as_str()
        };
        return Some(format!("detached @ {sha}"));
    }
    let name = if status.branch.is_empty() {
        "HEAD"
    } else {
        status.branch.as_str()
    };
    let mut parts = vec![name.to_string()];
    if status.ahead > 0 {
        parts.push(format!("↑{}", status.ahead));
    }
    if status.behind > 0 {
        parts.push(format!("↓{}", status.behind));
    }
    Some(parts.join(" "))
}

pub fn parse_repo_status(value: &Value) -> Option<RepoStatus> {
    let obj = value.as_object()?;
    let branch = obj.get("branch")?.as_str()?.to_string();
    let short_sha = obj.get("shortSha")?.as_str()?.to_string();
    let detached = obj.get("detached")?.as_bool()?;
    let upstream = match obj.get("upstream")? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        _ => return None,
    };
    let ahead = obj.get("ahead")?.as_i64()?;
    let behind = obj.get("behind")?.as_i64()?;
    Some(RepoStatus {
        branch,
        short_sha,
        detached,
        upstream,
        ahead,
        behind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_repo_status_label_and_can_rewrite_head_match_server_semantics() {
        assert_eq!(
            format_repo_status_label(&RepoStatus {
                branch: "main".into(),
                short_sha: "abc".into(),
                detached: false,
                upstream: None,
                ahead: 0,
                behind: 0,
            }),
            Some("main".into())
        );
        assert!(!can_rewrite_head(&RepoStatus {
            branch: "main".into(),
            short_sha: "abc".into(),
            detached: false,
            upstream: Some("origin/main".into()),
            ahead: 0,
            behind: 0,
        }));
    }

    #[test]
    fn can_push_head_when_ahead_or_no_upstream() {
        let base = RepoStatus {
            branch: "main".into(),
            short_sha: "abc".into(),
            detached: false,
            upstream: Some("origin/main".into()),
            ahead: 0,
            behind: 0,
        };
        assert!(can_push_head(&RepoStatus {
            ahead: 1,
            ..base.clone()
        }));
        assert!(!can_push_head(&base));
        assert!(can_push_head(&RepoStatus {
            upstream: None,
            ahead: 0,
            ..base.clone()
        }));
        assert!(!can_push_head(&RepoStatus {
            detached: true,
            ahead: 1,
            ..base
        }));
    }

    #[test]
    fn parse_repo_status_rejects_malformed_payloads() {
        assert!(parse_repo_status(&Value::Null).is_none());
        assert!(parse_repo_status(&serde_json::json!({ "branch": "main" })).is_none());
        assert_eq!(
            parse_repo_status(&serde_json::json!({
                "branch": "main",
                "shortSha": "abc",
                "detached": false,
                "upstream": null,
                "ahead": 1,
                "behind": 0,
            })),
            Some(RepoStatus {
                branch: "main".into(),
                short_sha: "abc".into(),
                detached: false,
                upstream: None,
                ahead: 1,
                behind: 0,
            })
        );
    }
}
