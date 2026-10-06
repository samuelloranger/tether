use super::*;
use tether_core::gitpanel::{GitFx, GitMsg, GitTarget};

impl TerminalModel {
    /// Where the active session's shell is, as far as this window knows. The exec side prefers
    /// the live `/proc` answer; these are what it falls back to.
    fn git_target(&self) -> Option<GitTarget> {
        let name = self.active_name()?;
        let fallback = self
            .tabs
            .get(name)
            .and_then(|t| t.term.reports().cwd.clone())
            .filter(|d| d.starts_with('/'))
            .or_else(|| {
                self.session_cwds
                    .get(name)
                    .filter(|d| d.starts_with('/'))
                    .cloned()
            });
        let pid = self.session_pids.get(name).copied().unwrap_or(0);
        (pid > 0 || fallback.is_some()).then_some(GitTarget { pid, fallback })
    }

    pub(crate) fn on_git(&mut self, msg: GitMsg, now: Duration, fx: &mut Vec<Effect>) {
        let session = self.active_name().map(str::to_string);
        let target = self.git_target();
        let out = self
            .git
            .handle(msg, now, session.as_deref(), target.is_some());
        let target = target.unwrap_or(GitTarget {
            pid: 0,
            fallback: None,
        });
        for effect in out {
            fx.push(match effect {
                GitFx::Run(job) => Effect::Git {
                    target: target.clone(),
                    job,
                },
                GitFx::OpenUrl(url) => Effect::Ui(UiEffect::OpenUrl(url)),
            });
        }
        let view = self.git.view();
        if view != self.git_shown {
            self.git_shown = view.clone();
            fx.push(Effect::Ui(UiEffect::Git(Box::new(view))));
        }
    }

    pub(crate) fn git_tick(&mut self, now: Duration, fx: &mut Vec<Effect>) {
        if self.git.is_open() {
            self.on_git(GitMsg::Tick, now, fx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{live, t};
    use super::*;
    use crate::terminal::testkit::session;
    use tether_core::git::PrList;
    use tether_core::gitpanel::{GitDone, GitJob, Workspace};

    fn jobs(fx: &[Effect]) -> Vec<GitJob> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Git { job, .. } => Some(job.clone()),
                _ => None,
            })
            .collect()
    }

    fn shown(fx: &[Effect]) -> Option<tether_core::gitpanel::GitView> {
        fx.iter().find_map(|e| match e {
            Effect::Ui(UiEffect::Git(v)) => Some((**v).clone()),
            _ => None,
        })
    }

    #[test]
    fn toggling_runs_a_workspace_job_for_the_active_session_and_shows_the_panel() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::Git(GitMsg::Toggle), t(10));
        let Some(Effect::Git { target, job }) = fx.iter().find(|e| matches!(e, Effect::Git { .. }))
        else {
            panic!("{fx:?}");
        };
        assert_eq!(target.pid, 1);
        assert_eq!(target.fallback.as_deref(), Some("/home/sam/a"));
        assert!(matches!(job, GitJob::Workspace { .. }));
        assert!(shown(&fx).unwrap().open);
    }

    #[test]
    fn an_unchanged_panel_is_not_pushed_again() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Git(GitMsg::Toggle), t(10));
        let fx = m.handle(Msg::Tick, t(20));
        assert!(shown(&fx).is_none());
    }

    #[test]
    fn answers_flow_back_into_the_view() {
        let mut m = live(vec![session("a", 1)]);
        let fx = m.handle(Msg::Git(GitMsg::Toggle), t(10));
        let GitJob::Workspace { req } = jobs(&fx)[0].clone() else {
            panic!();
        };
        let ws = Workspace {
            top: "/r".into(),
            branch: "main".into(),
            files: vec![],
            untracked: vec!["n.md".into()],
            commits: vec![],
            prs: PrList::List(vec![]),
        };
        let fx = m.handle(
            Msg::Git(GitMsg::Done(GitDone::Workspace {
                req,
                result: Ok(ws),
            })),
            t(20),
        );
        let view = shown(&fx).unwrap();
        assert_eq!(view.title, "main");
        assert_eq!(view.rows[0].primary, "n.md");
    }

    #[test]
    fn switching_tabs_reloads_for_the_new_session() {
        let mut m = live(vec![session("a", 1), session("b", 2)]);
        m.handle(Msg::Git(GitMsg::Toggle), t(10));
        m.handle(Msg::SelectTab("b".into()), t(20));
        let fx = m.handle(Msg::Tick, t(70));
        assert_eq!(jobs(&fx).len(), 1);
    }

    #[test]
    fn an_open_link_from_the_panel_goes_through_the_url_effect() {
        let mut m = live(vec![session("a", 1)]);
        m.handle(Msg::Git(GitMsg::Toggle), t(10));
        let fx = m.handle(
            Msg::Git(GitMsg::OpenLink("https://example.test/".into())),
            t(11),
        );
        assert!(fx.contains(&Effect::Ui(UiEffect::OpenUrl(
            "https://example.test/".into()
        ))));
        let fx = m.handle(
            Msg::Git(GitMsg::OpenLink("file:///etc/passwd".into())),
            t(12),
        );
        assert!(
            !fx.iter()
                .any(|e| matches!(e, Effect::Ui(UiEffect::OpenUrl(_))))
        );
    }
}
