//! Runs the panel's remote jobs on the control connection and hands the parsed answer back.

use std::sync::Arc;

use tether_core::git::{self, RepoDir};
use tether_core::gitpanel::{self as panel, GitDone, GitJob, GitMsg, GitTarget, MARKDOWN_CAP};

use crate::terminal::driver::MsgSink;
use crate::terminal::model::Msg;
use crate::terminal::remote::Remote;

const NO_DIRECTORY: &str = "No working directory for this session.";

pub async fn run<R: Remote>(remote: Arc<R>, target: GitTarget, job: GitJob, send: MsgSink) {
    let done = execute(remote.as_ref(), &target, job).await;
    send(Msg::Git(GitMsg::Done(done)));
}

async fn exec<R: Remote>(remote: &R, command: &str) -> Result<String, String> {
    remote.exec(command).await.map_err(|e| e.sentence())
}

/// The shell's live directory beats what `zmx ls` or the last OSC 7 said.
async fn resolve_dir<R: Remote>(remote: &R, target: &GitTarget) -> Result<RepoDir, String> {
    if let Some(command) = git::readlink_cwd_command(target.pid)
        && let Ok(out) = remote.exec(&command).await
        && let Some(dir) = RepoDir::new(&out)
    {
        return Ok(dir);
    }
    target
        .fallback
        .as_deref()
        .and_then(RepoDir::new)
        .ok_or_else(|| NO_DIRECTORY.to_owned())
}

pub async fn execute<R: Remote>(remote: &R, target: &GitTarget, job: GitJob) -> GitDone {
    match job {
        GitJob::Workspace { req } => {
            let raw = match resolve_dir(remote, target).await {
                Ok(dir) => exec(remote, &git::workspace_command(&dir)).await,
                Err(e) => Err(e),
            };
            GitDone::Workspace {
                req,
                result: panel::workspace_result(raw),
            }
        }
        GitJob::Docs { req, top } => {
            let raw = match RepoDir::new(&top) {
                Some(dir) => exec(remote, &git::docs_command(&dir)).await,
                None => Err(NO_DIRECTORY.into()),
            };
            GitDone::Docs {
                req,
                result: panel::docs_result(raw),
            }
        }
        GitJob::Commit { req, id } => {
            let raw = match resolve_dir(remote, target).await {
                Ok(dir) => match git::commit_command(&dir, &id) {
                    Some(command) => exec(remote, &command).await,
                    None => Err("That is not a commit id.".into()),
                },
                Err(e) => Err(e),
            };
            GitDone::Commit {
                req,
                result: panel::commit_result(raw),
            }
        }
        GitJob::PrDetail { req, number } => {
            let raw = match resolve_dir(remote, target).await {
                Ok(dir) => exec(remote, &git::pr_detail_command(&dir, number)).await,
                Err(e) => Err(e),
            };
            GitDone::PrDetail {
                req,
                detail: panel::pr_detail_result(raw),
            }
        }
        GitJob::PrDiff { req, number } => {
            let raw = match resolve_dir(remote, target).await {
                Ok(dir) => exec(remote, &git::pr_diff_command(&dir, number)).await,
                Err(e) => Err(e),
            };
            GitDone::PrDiff {
                req,
                result: panel::pr_diff_result(raw),
            }
        }
        GitJob::Merge {
            req,
            number,
            method,
        } => {
            let raw = match resolve_dir(remote, target).await {
                Ok(dir) => exec(remote, &git::merge_command(&dir, number, method)).await,
                Err(e) => Err(e),
            };
            GitDone::Merge {
                req,
                result: panel::merge_result(raw),
            }
        }
        GitJob::Markdown { req, path } => {
            let raw = match git::read_file_command(&path, MARKDOWN_CAP) {
                Some(command) => exec(remote, &command).await,
                None => Err("That path can't be opened.".into()),
            };
            GitDone::Markdown {
                req,
                result: panel::markdown_result(raw),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::testkit::FakeRemote;
    use tether_core::connect::ConnectError;
    use tether_core::git::MergeMethod;

    fn target() -> GitTarget {
        GitTarget {
            pid: 42,
            fallback: Some("/fallback".into()),
        }
    }

    fn reply(remote: &FakeRemote, replies: &[Result<&str, ConnectError>]) {
        let mut q = remote.exec_queue.lock().unwrap();
        for r in replies {
            q.push_back(r.clone().map(str::to_owned));
        }
    }

    #[tokio::test]
    async fn the_live_directory_comes_from_proc_and_is_quoted_into_the_command() {
        let remote = FakeRemote::default();
        reply(
            &remote,
            &[
                Ok("/home/u/it's here\n"),
                Ok("nope\u{1D}\u{1D}\u{1D}\u{1D}\n__TETHER_RC__0"),
            ],
        );
        let done = execute(&remote, &target(), GitJob::Workspace { req: 3 }).await;
        let log = remote.log();
        assert_eq!(log[0], "exec readlink /proc/42/cwd 2>/dev/null");
        assert!(log[1].starts_with("exec sh -c "));
        assert!(!log[1].contains("it's here"), "{}", log[1]);
        let GitDone::Workspace { req, result } = done else {
            panic!();
        };
        assert_eq!(req, 3);
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn without_proc_the_fallback_directory_is_used() {
        let remote = FakeRemote::default();
        reply(
            &remote,
            &[Ok(""), Ok("x\u{1D}\u{1D}\u{1D}\u{1D}\n__TETHER_RC__0")],
        );
        execute(&remote, &target(), GitJob::Workspace { req: 1 }).await;
        assert!(remote.log()[1].contains("/fallback"));
    }

    #[tokio::test]
    async fn no_directory_at_all_runs_nothing() {
        let remote = FakeRemote::default();
        reply(&remote, &[Ok("relative\n")]);
        let done = execute(
            &remote,
            &GitTarget {
                pid: 0,
                fallback: None,
            },
            GitJob::Workspace { req: 1 },
        )
        .await;
        assert!(remote.log().is_empty());
        let GitDone::Workspace { result, .. } = done else {
            panic!();
        };
        assert_eq!(result, Err(NO_DIRECTORY.into()));
    }

    #[tokio::test]
    async fn a_transport_failure_is_the_error_text() {
        let remote = FakeRemote::default();
        reply(&remote, &[Ok("/r\n"), Err(ConnectError::Timeout)]);
        let done = execute(&remote, &target(), GitJob::PrDiff { req: 1, number: 5 }).await;
        let GitDone::PrDiff { result, .. } = done else {
            panic!();
        };
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn merge_runs_gh_with_the_chosen_flag_and_reports_failure() {
        let remote = FakeRemote::default();
        reply(
            &remote,
            &[Ok("/r\n"), Ok("GraphQL: blocked\n__TETHER_RC__1")],
        );
        let done = execute(
            &remote,
            &target(),
            GitJob::Merge {
                req: 2,
                number: 9,
                method: MergeMethod::Rebase,
            },
        )
        .await;
        assert!(remote.log()[1].contains("gh pr merge 9 --rebase"));
        let GitDone::Merge { result, .. } = done else {
            panic!();
        };
        assert_eq!(result, Err("GraphQL: blocked".into()));
    }

    #[tokio::test]
    async fn markdown_is_read_with_a_byte_cap_and_a_hostile_commit_id_is_refused() {
        let remote = FakeRemote::default();
        reply(&remote, &[Ok("# Hi\n__TETHER_RC__0")]);
        let done = execute(
            &remote,
            &target(),
            GitJob::Markdown {
                req: 1,
                path: "/r/README.md".into(),
            },
        )
        .await;
        assert!(remote.log()[0].contains("head -c 524289"));
        assert_eq!(
            done,
            GitDone::Markdown {
                req: 1,
                result: Ok(("# Hi".into(), false))
            }
        );
        let remote = FakeRemote::default();
        reply(&remote, &[Ok("/r\n")]);
        let done = execute(
            &remote,
            &target(),
            GitJob::Commit {
                req: 1,
                id: "abc; reboot".into(),
            },
        )
        .await;
        assert_eq!(remote.log().len(), 1);
        assert!(matches!(done, GitDone::Commit { result: Err(_), .. }));
    }
}
