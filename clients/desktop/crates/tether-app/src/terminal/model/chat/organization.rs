use super::{ChatJob, ChatMsg, Chats, ExecTag, Out};
use std::time::Duration;
use tether_core::acp::options::StartOptions;
use tether_core::acp::{
    host,
    organization::{self, Branch, Parent},
};
use tether_core::zmx::shell_quote;

#[derive(Clone)]
pub struct BranchDialog {
    pub branch: Branch,
    pub title: String,
    pub cwd: String,
    pub agent: &'static tether_core::acp::agent::AgentProfile,
    pub multi: bool,
}

impl Chats {
    pub(super) fn poll_usage(&mut self, now: Duration, out: &mut Out) {
        if !self.connected
            || !self.focused
            || !self.usage_visible
            || self.usage_loading
            || self
                .usage_asked
                .is_some_and(|at| now.saturating_sub(at) < Duration::from_secs(60))
        {
            return;
        }
        self.usage_asked = Some(now);
        self.usage_loading = true;
        self.dirty = true;
        out.jobs.push(ChatJob::Exec {
            tag: ExecTag::Usage,
            command: format!("{} usage --json 2>&1", host::TETHER),
        });
    }
    fn patch_organization(&mut self, name: &str, patch: serde_json::Value, out: &mut Out) {
        self.actions = None;
        if !self.connected {
            self.organization_error = "Connect to the host to organize chats.".into();
            return;
        }
        self.organization_error.clear();
        out.jobs.push(ChatJob::Exec {
            tag: ExecTag::Organize { name: name.into() },
            command: format!(
                "{} organize {} --json {} 2>&1",
                host::TETHER,
                shell_quote(name),
                shell_quote(&patch.to_string())
            ),
        });
    }
    pub(super) fn handle_organization(
        &mut self,
        msg: &ChatMsg,
        now: Duration,
        out: &mut Out,
    ) -> bool {
        use serde_json::json;
        match msg {
            ChatMsg::Actions(name) => {
                self.actions = Some(name.clone());
                self.organization_error.clear();
            }
            ChatMsg::ActionsClose => {
                self.actions = None;
                self.rename = None;
                self.organization_error.clear();
            }
            ChatMsg::Archived(show) => self.archived = *show,
            ChatMsg::CollapseProject(path) => {
                if !self.collapsed_projects.remove(path) {
                    self.collapsed_projects.insert(path.clone());
                }
            }
            ChatMsg::Pin(name) => {
                let pinned = self
                    .ordered()
                    .iter()
                    .find(|c| &c.name == name)
                    .is_some_and(|c| c.organization.pinned);
                self.patch_organization(name, json!({"pinned":!pinned}), out);
            }
            ChatMsg::Archive(name) => self.patch_organization(name, json!({"archived":true}), out),
            ChatMsg::Restore(name) => self.patch_organization(name, json!({"archived":false}), out),
            ChatMsg::Rename(name) => {
                self.rename = Some(name.clone());
                self.actions = None;
            }
            ChatMsg::RenameSave(title) => {
                if let Some(name) = self.rename.take() {
                    self.patch_organization(&name, json!({"title":title.trim()}), out);
                }
            }
            ChatMsg::RefreshUsage => self.poll_usage(now, out),
            ChatMsg::ExecDone {
                tag: ExecTag::Usage,
                result,
            } => {
                self.usage_loading = false;
                match result
                    .as_ref()
                    .ok()
                    .and_then(|s| serde_json::from_str(s).ok())
                {
                    Some(usage) => self.plan_usage = usage,
                    None => {
                        for usage in [&mut self.plan_usage.claude, &mut self.plan_usage.codex] {
                            usage.stale = true;
                            usage.error=Some("Usage unavailable. Update tether on the host or check provider sign-in.".into());
                        }
                    }
                }
            }
            ChatMsg::ExecDone {
                tag: ExecTag::Organize { name },
                result,
            } => {
                match result
                    .as_ref()
                    .ok()
                    .and_then(|s| serde_json::from_str::<organization::Organization>(s).ok())
                {
                    Some(mut metadata) => {
                        if let Some(title) = result
                            .as_ref()
                            .ok()
                            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                            .and_then(|v| {
                                v.get("title")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_string)
                            })
                        {
                            metadata.custom_title = title;
                        }
                        for chat in self
                            .listed
                            .iter_mut()
                            .chain(self.provisional.iter_mut())
                            .filter(|c| &c.name == name)
                        {
                            chat.organization = metadata.clone();
                        }
                        if self
                            .pending_branch
                            .as_ref()
                            .is_some_and(|(pending, _)| pending == name)
                        {
                            let (_, dialog) = self.pending_branch.take().unwrap();
                            self.branch_dialog = None;
                            self.open_route(
                                name.clone(),
                                dialog.cwd,
                                None,
                                dialog.multi,
                                dialog.agent,
                                StartOptions::Stored,
                                now,
                                out,
                            );
                            if let Some(chat) =
                                self.provisional.iter_mut().find(|c| &c.name == name)
                            {
                                chat.organization = metadata.clone();
                            }
                            self.draft_seq += 1;
                        }
                        if metadata.archived && self.active.as_deref() == Some(name) {
                            self.leave_active(now, out);
                        }
                    }
                    None => {
                        if self
                            .pending_branch
                            .as_ref()
                            .is_some_and(|(pending, _)| pending == name)
                        {
                            self.pending_branch = None;
                            if let Some(files) = &self.files {
                                files.clear(name);
                            }
                        }
                        self.organization_error =
                            "Couldn't save chat organization. Update tether on the host and retry."
                                .into();
                    }
                }
            }
            ChatMsg::Branch(key) => {
                if self.pending_branch.is_some() {
                    return true;
                }
                self.actions = None;
                let Some(s) = self.active_session() else {
                    return true;
                };
                let Some(id) = key.strip_prefix("item:").unwrap_or(key).parse::<i64>().ok() else {
                    return true;
                };
                let title = self
                    .ordered()
                    .into_iter()
                    .find(|c| c.name == s.name)
                    .map(|c| self.title_of(c))
                    .unwrap_or_else(|| s.title());
                if s.state().is_queued(id) {
                    self.organization_error =
                        "That prompt has not started. Wait for it before branching.".into();
                    return true;
                }
                let parent = Parent {
                    name: s.name.clone(),
                    title: title.clone(),
                    method: "copy".into(),
                };
                match organization::branch_before(&s.state().items, id, parent) {
                    Ok(branch) => {
                        self.branch_dialog = Some(BranchDialog {
                            title: format!("{title} · alternative"),
                            branch,
                            cwd: s.cwd.clone(),
                            agent: s.agent().unwrap_or(&tether_core::acp::agent::CLAUDE),
                            multi: self
                                .ordered()
                                .into_iter()
                                .find(|c| c.name == s.name)
                                .is_some_and(|c| c.multi_client),
                        });
                    }
                    Err(message) => self.organization_error = message.into(),
                }
            }
            ChatMsg::BranchCancel => {
                if self.pending_branch.is_none() {
                    self.branch_dialog = None;
                    self.organization_error.clear();
                }
            }
            ChatMsg::BranchCreate { title, prompt } => {
                if self.pending_branch.is_some() {
                    return true;
                }
                let Some(mut dialog) = self.branch_dialog.clone() else {
                    return true;
                };
                if !self.connected {
                    self.organization_error =
                        "Connect to the host before creating a branch.".into();
                    self.branch_dialog = Some(dialog);
                    return true;
                }
                let name = host::new_chat_name();
                dialog.branch.draft = prompt.clone();
                let Some(files) = self.files.as_ref() else {
                    self.organization_error =
                        "Chat storage is unavailable; the branch was not created.".into();
                    return true;
                };
                if files.save_branch(&name, &dialog.branch).is_err() {
                    self.organization_error = "Couldn't save the branch draft.".into();
                    self.branch_dialog = Some(dialog);
                    return true;
                }
                let _ = files.set_title(&name, title);
                self.patch_organization(
                    &name,
                    json!({"title":title.trim(),"parent":dialog.branch.parent}),
                    out,
                );
                dialog.title = title.clone();
                self.branch_dialog = Some(dialog.clone());
                self.pending_branch = Some((name, dialog));
            }
            ChatMsg::Parent => {
                let parent = self
                    .active_session()
                    .and_then(|s| s.branch.as_ref())
                    .map(|b| b.parent.name.clone())
                    .or_else(|| {
                        self.active
                            .as_ref()
                            .and_then(|name| self.ordered().into_iter().find(|c| &c.name == name))
                            .and_then(|c| c.organization.parent.as_ref().map(|p| p.name.clone()))
                    });
                if let Some(parent) = parent {
                    self.select(&parent, now, out);
                }
            }
            _ => return false,
        }
        self.dirty = true;
        true
    }
}
