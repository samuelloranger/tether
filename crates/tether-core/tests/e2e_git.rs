//! Every git operation the clients expose, against a real repo. Staging,
//! committing and discarding are destructive, so they only ever touch the
//! throwaway repo this suite creates.

mod support;

use std::collections::BTreeMap;
use std::fs;

use serde_json::json;
use support::{eventually, scratch_repo, Server};
use tether_core::git_api;

/// Starts a server rooted in a scratch repo plus a running session, which is
/// what the git routes resolve their repo root from.
async fn repo_server() -> (tempfile::TempDir, Server, String) {
    let repo = scratch_repo();
    let server = Server::start_in(Some(repo.path())).await;
    let client = server.client();

    // The holder starts the shell in `session.defaultCwd`, not the server's cwd,
    // and the git routes resolve their root from the shell's *live* cwd. Pointing
    // the setting at the scratch repo is what puts the session inside it.
    let (status, body) = server
        .exec(&client.patch(
            "/api/config",
            BTreeMap::new(),
            Some(json!({ "session": { "defaultCwd": repo.path() } }).to_string()),
        ))
        .await;
    assert_eq!(status, 200, "config patch failed: {body}");

    let (status, body) = server
        .exec(&client.post(
            "/api/sessions/start",
            BTreeMap::new(),
            Some(json!({ "id": "g1", "cols": 80, "rows": 24 }).to_string()),
        ))
        .await;
    assert_eq!(status, 200, "session start failed: {body}");
    eventually("the session to be running", || async {
        let (_, body) = server.exec(&client.get("/api/sessions", BTreeMap::new())).await;
        let found = body.as_array()?.iter().find(|s| s["id"] == "g1")?.clone();
        (found["status"] == "running").then_some(())
    })
    .await;
    (repo, server, "g1".to_string())
}

#[tokio::test]
async fn reports_status_and_diff_for_a_working_tree_change() {
    let (repo, server, session) = repo_server().await;
    let client = server.client();
    fs::write(repo.path().join("tracked.txt"), "one\ntwo-changed\nthree\n").unwrap();
    fs::write(repo.path().join("fresh.txt"), "new file\n").unwrap();

    let (status, body) = server
        .exec(&git_api::git_status_request(&client, &session))
        .await;
    let parsed = git_api::parse_git_status_response(status, &body).expect("status parses");
    assert_eq!(parsed.branch, "main", "unexpected branch in {body}");

    let (status, body) = server
        .exec(&git_api::diff_summary_request(&client, &session))
        .await;
    let summary = git_api::parse_diff_summary_response(status, &body).expect("summary parses");
    let names: Vec<&str> = summary.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
        names.contains(&"tracked.txt"),
        "the modified file is missing from {names:?}"
    );

    let (status, body) = server
        .exec(&git_api::diff_request(&client, &session, Some("tracked.txt"), None))
        .await;
    let payload = git_api::parse_diff_payload(status, &body).expect("diff parses");
    assert!(
        payload.diff.contains("two-changed"),
        "the diff does not mention the change: {}",
        payload.diff
    );
}

#[tokio::test]
async fn stages_unstages_and_commits() {
    let (repo, server, session) = repo_server().await;
    let client = server.client();
    fs::write(repo.path().join("tracked.txt"), "one\nstaged-change\nthree\n").unwrap();

    let (status, body) = server
        .exec(&git_api::stage_request(&client, &session, "tracked.txt"))
        .await;
    git_api::parse_ok_response(status, &body).expect("stage");
    let staged = eventually("the file to read as staged", || async {
        let (status, body) = server
            .exec(&git_api::git_status_request(&client, &session))
            .await;
        let parsed = git_api::parse_git_status_response(status, &body).ok()?;
        let (_, body) = server
            .exec(&git_api::diff_summary_request(&client, &session))
            .await;
        let staged_flag = body["files"]
            .as_array()?
            .iter()
            .find(|f| f["path"] == "tracked.txt")?
            .get("staged")
            .and_then(|v| v.as_bool());
        staged_flag.unwrap_or(false).then_some(parsed)
    })
    .await;
    assert_eq!(staged.branch, "main");

    let (status, body) = server
        .exec(&git_api::unstage_request(&client, &session, "tracked.txt"))
        .await;
    git_api::parse_ok_response(status, &body).expect("unstage");

    let (status, body) = server
        .exec(&git_api::stage_all_request(&client, &session))
        .await;
    git_api::parse_ok_response(status, &body).expect("stage-all");

    let (status, body) = server
        .exec(&git_api::commit_request(&client, &session, "e2e commit", false))
        .await;
    git_api::parse_ok_response(status, &body).expect("commit");

    let (status, body) = server
        .exec(&git_api::git_log_request(&client, &session, 10))
        .await;
    let log = git_api::parse_git_log_response(status, &body).expect("log parses");
    assert_eq!(
        log.first().map(|entry| entry.subject.as_str()),
        Some("e2e commit"),
        "the commit is not at the head of {log:?}"
    );

    // The commit's own diff must be retrievable by sha — that is what Review shows.
    let sha = log.first().expect("a commit").sha.clone();
    let (status, body) = server
        .exec(&git_api::git_commit_diff_request(&client, &session, &sha, None))
        .await;
    let payload = git_api::parse_diff_payload(status, &body).expect("commit diff parses");
    assert!(
        payload.diff.contains("staged-change"),
        "the commit diff lost the change: {}",
        payload.diff
    );

    let (status, body) = server
        .exec(&git_api::undo_commit_request(&client, &session))
        .await;
    git_api::parse_ok_response(status, &body).expect("undo-commit");
    let (status, body) = server
        .exec(&git_api::git_log_request(&client, &session, 10))
        .await;
    let log = git_api::parse_git_log_response(status, &body).expect("log parses");
    assert_eq!(
        log.first().map(|entry| entry.subject.as_str()),
        Some("initial"),
        "undo-commit did not restore the previous head: {log:?}"
    );
}

#[tokio::test]
async fn discards_a_working_tree_change() {
    let (repo, server, session) = repo_server().await;
    let client = server.client();
    let path = repo.path().join("tracked.txt");
    fs::write(&path, "one\nto-be-discarded\nthree\n").unwrap();

    let (status, body) = server
        .exec(&git_api::discard_request(&client, &session, "tracked.txt"))
        .await;
    git_api::parse_ok_response(status, &body).expect("discard");
    let restored = fs::read_to_string(&path).unwrap();
    assert_eq!(
        restored, "one\ntwo\nthree\n",
        "discard did not restore the committed content"
    );
}

#[tokio::test]
async fn stages_and_unstages_a_single_hunk() {
    let (repo, server, session) = repo_server().await;
    let client = server.client();
    // Two changes far enough apart to land in separate hunks.
    fs::write(
        repo.path().join("tracked.txt"),
        "top-change\ntwo\nthree\n\n\n\n\n\n\n\n\n\n\n\n\n\nbottom-change\n",
    )
    .unwrap();

    let (status, body) = server
        .exec(&git_api::stage_hunk_request(&client, &session, "tracked.txt", 0))
        .await;
    git_api::parse_ok_response(status, &body)
        .unwrap_or_else(|e| panic!("stage-hunk failed: {e} / {body}"));

    let (status, body) = server
        .exec(&git_api::unstage_hunk_request(&client, &session, "tracked.txt", 0))
        .await;
    git_api::parse_ok_response(status, &body)
        .unwrap_or_else(|e| panic!("unstage-hunk failed: {e} / {body}"));
}

/// A repo with no remote must report a real failure. Push silently reporting ok
/// would be worse than push not working.
#[tokio::test]
async fn push_without_a_remote_reports_an_error() {
    let (_repo, server, session) = repo_server().await;
    let client = server.client();
    let (status, body) = server
        .exec(&git_api::push_request(&client, &session))
        .await;
    let result = git_api::parse_ok_response(status, &body);
    assert!(
        result.is_err() || body.get("ok") == Some(&json!(false)),
        "push with no remote reported success: {status} {body}"
    );
}
