//! The workspace surface: directory listing, file reads, containment, uploads
//! and presentations.

mod support;

use std::collections::BTreeMap;
use std::fs;

use serde_json::json;
use support::{eventually, scratch_repo, Server};
use tether_core::workspace;

async fn workspace_server() -> (tempfile::TempDir, Server, String) {
    let repo = scratch_repo();
    let server = Server::start_in(Some(repo.path())).await;
    let client = server.client();
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
            Some(json!({ "id": "w1", "cols": 80, "rows": 24 }).to_string()),
        ))
        .await;
    assert_eq!(status, 200, "session start failed: {body}");
    eventually("the session to be running", || async {
        let (_, body) = server
            .exec(&client.get("/api/sessions", BTreeMap::new()))
            .await;
        let found = body.as_array()?.iter().find(|s| s["id"] == "w1")?.clone();
        (found["status"] == "running").then_some(())
    })
    .await;
    (repo, server, "w1".to_string())
}

#[tokio::test]
async fn lists_a_directory() {
    let (repo, server, session) = workspace_server().await;
    let client = server.client();
    fs::create_dir(repo.path().join("sub")).unwrap();

    let (status, body) = server
        .exec(&client.get(&format!("/api/sessions/{session}/dir"), BTreeMap::new()))
        .await;
    assert_eq!(status, 200, "dir listing failed: {body}");
    let names: Vec<&str> = body["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .map(|e| e["name"].as_str().unwrap_or_default())
        .collect();
    assert!(names.contains(&"tracked.txt"), "missing file in {names:?}");
    assert!(names.contains(&"sub"), "missing directory in {names:?}");
    // Directories sort ahead of files, which is what the tree relies on.
    let kinds: Vec<&str> = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap_or_default())
        .collect();
    let first_file = kinds.iter().position(|k| *k == "file");
    let last_dir = kinds.iter().rposition(|k| *k == "dir");
    if let (Some(first_file), Some(last_dir)) = (first_file, last_dir) {
        assert!(
            last_dir < first_file,
            "directories are not listed first: {kinds:?}"
        );
    }
}

/// The listing sorts before it slices. A name that sorts early must be
/// reachable even in a directory past the page cap — otherwise entries are
/// permanently invisible, which is what the earlier version did.
#[tokio::test]
async fn a_directory_past_the_page_cap_still_shows_its_earliest_names() {
    let (repo, server, session) = workspace_server().await;
    let client = server.client();
    let big = repo.path().join("big");
    fs::create_dir(&big).unwrap();
    for i in 0..2100 {
        fs::write(big.join(format!("f{i:05}.txt")), "x").unwrap();
    }
    // Created last, sorts first.
    fs::write(big.join("aaa-sorts-first.txt"), "x").unwrap();

    let (status, body) = server
        .exec(&client.get(
            &format!("/api/sessions/{session}/dir?path=big"),
            BTreeMap::new(),
        ))
        .await;
    assert_eq!(status, 200, "dir listing failed: {body}");
    assert_eq!(
        body["truncated"], true,
        "a 2101-entry dir should report truncated"
    );
    let names: Vec<&str> = body["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|e| e["name"].as_str().unwrap_or_default())
        .collect();
    assert!(
        names.contains(&"aaa-sorts-first.txt"),
        "the earliest-sorting name was sliced away; first few: {:?}",
        &names[..names.len().min(3)]
    );
}

#[tokio::test]
async fn reads_a_text_file_and_refuses_one_outside_the_root() {
    let (_repo, server, session) = workspace_server().await;
    let client = server.client();

    let (status, body) = server
        .exec(&client.get(
            &format!("/api/sessions/{session}/file?path=tracked.txt"),
            BTreeMap::new(),
        ))
        .await;
    let file = workspace::parse_workspace_file(status, &body).expect("file parses");
    assert!(
        file.content.contains("two"),
        "unexpected content: {:?}",
        file.content
    );

    // Containment: an escape attempt must be refused, not served.
    let (status, body) = server
        .exec(&client.get(
            &format!("/api/sessions/{session}/file?path=../../../etc/passwd"),
            BTreeMap::new(),
        ))
        .await;
    assert!(
        status >= 400,
        "a path outside the workspace was served with {status}: {body}"
    );
}

/// Uploads land under `~/.tether/uploads/<session>` — note that path is NOT
/// relocated by `TETHER_DB_PATH`, so this test writes into the real state dir
/// under a clearly-labelled session id and removes it afterwards.
#[tokio::test]
async fn accepts_a_multipart_upload() {
    let (_repo, server, session) = workspace_server().await;
    let boundary = "e2eboundary";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"e2e-upload.txt\"\r\nContent-Type: text/plain\r\n\r\nuploaded-by-e2e\r\n--{boundary}--\r\n"
    );

    let response = server
        .http
        .post(format!(
            "http://127.0.0.1:{}/api/sessions/{session}/upload",
            server.port
        ))
        .header("Authorization", format!("Bearer {}", server.password))
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .expect("upload");
    let status = response.status().as_u16();
    let json: serde_json::Value = response.json().await.expect("upload json");
    assert_eq!(status, 200, "upload failed: {json}");
    assert_eq!(json["ok"], true, "upload reported failure: {json}");

    let written = json["path"].as_str().expect("a destination path");
    let contents = fs::read_to_string(written).expect("the uploaded file exists");
    assert_eq!(contents, "uploaded-by-e2e");
    let _ = fs::remove_file(written);
    if let Some(parent) = std::path::Path::new(written).parent() {
        let _ = fs::remove_dir(parent);
    }
}

#[tokio::test]
async fn lists_presentations_when_there_are_none() {
    let server = Server::start().await;
    let client = server.client();
    let (status, body) = server
        .exec(&client.get("/api/presentations", BTreeMap::new()))
        .await;
    let listed = workspace::parse_presentations(status, &body).expect("presentations parse");
    assert!(
        listed.is_empty(),
        "a fresh server should have no presentations, got {listed:?}"
    );
}
