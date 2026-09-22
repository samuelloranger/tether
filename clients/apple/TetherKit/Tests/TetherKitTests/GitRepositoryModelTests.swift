import XCTest
@testable import TetherKit

final class GitRepositoryModelTests: XCTestCase {
  func test_parses_branch_and_recent_commits_from_git_machine_output() {
    XCTAssertEqual(GitRepositoryModel.branch(from: "feat/git-workspace\n"), "feat/git-workspace")

    let commits = GitRepositoryModel.commits(from: "abc123\u{1F}Add repository workspace\u{1F}Sam\u{1F}1727000000\u{1E}")
    XCTAssertEqual(commits, [
      GitCommit(id: "abc123", subject: "Add repository workspace", author: "Sam", timestamp: 1_727_000_000)
    ])
  }

  func test_one_command_carries_all_four_workspace_sections() {
    let output = "PATCH\u{1D}feat/x\n\u{1D}abc\u{1F}s\u{1F}a\u{1F}1\u{1E}\u{1D}[]"
    let sections = GitRepositoryModel.workspaceSections(output)
    XCTAssertEqual(sections?.diff, "PATCH")
    XCTAssertEqual(sections?.branch, "feat/x\n")
    XCTAssertEqual(sections?.commits, "abc\u{1F}s\u{1F}a\u{1F}1\u{1E}")
    XCTAssertEqual(sections?.pullRequests, "[]")
    XCTAssertNil(GitRepositoryModel.workspaceSections("only\u{1D}two"))
  }

  func test_a_record_separator_inside_a_section_does_not_split_it() {
    // The commit format ends every record with 0x1e, and a patch may contain
    // one: neither may be mistaken for the boundary between sections.
    let commits = "a\u{1F}s\u{1F}n\u{1F}1\u{1E}b\u{1F}t\u{1F}n\u{1F}2\u{1E}"
    let sections = GitRepositoryModel.workspaceSections("+a\u{1E}b\u{1D}main\n\u{1D}\(commits)\u{1D}[]")
    XCTAssertEqual(sections?.diff, "+a\u{1E}b")
    XCTAssertEqual(sections?.commits, commits)
    XCTAssertEqual(GitRepositoryModel.commits(from: sections?.commits ?? "").count, 2)
  }

  func test_parses_open_pull_requests_from_gh_json() throws {
    let json = """
    [{"number":196,"title":"Native interactions","headRefName":"feat/native","baseRefName":"main","url":"https://example.test/pr/196","updatedAt":"2026-09-22T01:00:00Z","isDraft":false,"changedFiles":12,"reviewDecision":"REVIEW_REQUIRED"}]
    """

    XCTAssertEqual(try GitRepositoryModel.pullRequests(from: json), [
      GitPullRequest(number: 196, title: "Native interactions", head: "feat/native", base: "main", url: "https://example.test/pr/196", updatedAt: "2026-09-22T01:00:00Z", isDraft: false, changedFiles: 12, reviewDecision: "REVIEW_REQUIRED", rawState: nil)
    ])
  }

  func test_an_empty_list_means_there_are_no_pull_requests() {
    XCTAssertEqual(GitRepositoryModel.pullRequestResult(from: "[]"), .list([]))
    XCTAssertEqual(GitRepositoryModel.pullRequestResult(from: "  []\n"), .list([]))
  }

  func test_a_missing_github_cli_is_reported_as_such() {
    XCTAssertEqual(
      GitRepositoryModel.pullRequestResult(from: GitRepositoryModel.ghMissingSentinel),
      .toolMissing)
  }

  func test_anything_else_is_carried_back_as_the_reason_it_failed() {
    XCTAssertEqual(
      GitRepositoryModel.pullRequestResult(from: "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n"),
      .failed("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable."))
    XCTAssertEqual(
      GitRepositoryModel.pullRequestResult(from: "failed to run git: fatal: not a git repository\nsecond line\n"),
      .failed("failed to run git: fatal: not a git repository"))
  }

  func test_a_populated_list_still_parses() {
    let json = """
    [{"number":7,"title":"Fix","headRefName":"fix/a","baseRefName":"main","url":"https://example.test/pr/7","updatedAt":"2026-09-22T01:00:00Z","isDraft":true,"changedFiles":1,"reviewDecision":null}]
    """
    guard case let .list(pulls) = GitRepositoryModel.pullRequestResult(from: json) else {
      return XCTFail("expected a parsed list")
    }
    XCTAssertEqual(pulls.map(\.number), [7])
  }

  func test_parses_check_runs_with_their_state_and_link() {
    let json = """
    [{"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://example.test/lint"},
     {"__typename":"CheckRun","name":"ios-build","status":"IN_PROGRESS","conclusion":"","detailsUrl":"https://example.test/ios"},
     {"__typename":"CheckRun","name":"flaky","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://example.test/flaky"}]
    """

    let checks = GitRepositoryModel.checks(from: json)

    XCTAssertEqual(checks.map(\.name), ["lint", "ios-build", "flaky"])
    XCTAssertEqual(checks.map(\.state), [.passed, .running, .failed])
    XCTAssertEqual(checks.first?.url, "https://example.test/lint")
  }

  func test_parses_the_older_status_context_shape_too() {
    let json = """
    [{"__typename":"StatusContext","context":"ci/external","state":"SUCCESS","targetUrl":"https://example.test/ext"}]
    """
    let checks = GitRepositoryModel.checks(from: json)
    XCTAssertEqual(checks.map(\.name), ["ci/external"])
    XCTAssertEqual(checks.map(\.state), [.passed])
  }

  func test_skipped_and_neutral_runs_are_not_failures() {
    let json = """
    [{"__typename":"CheckRun","name":"optional","status":"COMPLETED","conclusion":"SKIPPED","detailsUrl":""},
     {"__typename":"CheckRun","name":"advisory","status":"COMPLETED","conclusion":"NEUTRAL","detailsUrl":""}]
    """
    XCTAssertEqual(GitRepositoryModel.checks(from: json).map(\.state), [.skipped, .skipped])
  }

  func test_unreadable_output_yields_no_checks_rather_than_a_crash() {
    XCTAssertEqual(GitRepositoryModel.checks(from: "not json"), [])
    XCTAssertEqual(GitRepositoryModel.checks(from: "[]"), [])
  }

  /// The screen keeps polling only while something is still running.
  func test_a_pipeline_is_running_until_every_check_settles() {
    let running = [GitCheck(name: "a", state: .running, url: ""), GitCheck(name: "b", state: .passed, url: "")]
    XCTAssertTrue(GitRepositoryModel.isRunning(running))
    XCTAssertFalse(GitRepositoryModel.isRunning([GitCheck(name: "a", state: .failed, url: "")]))
    XCTAssertFalse(GitRepositoryModel.isRunning([]))
  }

  func test_the_headline_names_what_matters_first() {
    XCTAssertEqual(GitRepositoryModel.checkHeadline([]), "No checks")
    XCTAssertEqual(
      GitRepositoryModel.checkHeadline([GitCheck(name: "a", state: .passed, url: ""), GitCheck(name: "b", state: .passed, url: "")]),
      "2 checks passed")
    XCTAssertEqual(
      GitRepositoryModel.checkHeadline([GitCheck(name: "a", state: .failed, url: ""), GitCheck(name: "b", state: .passed, url: "")]),
      "1 failing")
    // Failing outranks running: it is the thing to act on.
    XCTAssertEqual(
      GitRepositoryModel.checkHeadline([GitCheck(name: "a", state: .failed, url: ""), GitCheck(name: "b", state: .running, url: "")]),
      "1 failing")
    XCTAssertEqual(
      GitRepositoryModel.checkHeadline([GitCheck(name: "a", state: .running, url: ""), GitCheck(name: "b", state: .passed, url: "")]),
      "1 of 2 running")
  }

  // MARK: - merge gates

  private func gate(_ status: String, mergeable: String = "MERGEABLE", isDraft: Bool = false) -> GitMergeGate {
    GitRepositoryModel.mergeGate(
      from: """
      {"mergeable":"\(mergeable)","mergeStateStatus":"\(status)","isDraft":\(isDraft)}
      """)
  }

  func test_github_says_the_pull_request_can_merge() {
    XCTAssertEqual(gate("CLEAN"), .ready)
    // A non-required check may be red and the merge still allowed.
    XCTAssertEqual(gate("UNSTABLE"), .ready)
    XCTAssertEqual(gate("HAS_HOOKS"), .ready)
    XCTAssertTrue(gate("CLEAN").canMerge)
  }

  func test_each_refusal_keeps_the_reason_github_gave() {
    XCTAssertEqual(gate("BLOCKED"), .blocked)
    XCTAssertEqual(gate("BEHIND"), .behind)
    XCTAssertEqual(gate("DIRTY"), .conflicted)
    XCTAssertEqual(gate("DRAFT"), .draft)
    for status in ["BLOCKED", "BEHIND", "DIRTY", "DRAFT"] {
      XCTAssertFalse(gate(status).canMerge, status)
    }
  }

  func test_a_conflict_outranks_the_blocked_github_reports_alongside_it() {
    // GitHub reports a conflicted pull request as BLOCKED once branch
    // protection is on; "resolve the conflicts" is the useful half.
    XCTAssertEqual(gate("BLOCKED", mergeable: "CONFLICTING"), .conflicted)
  }

  func test_a_draft_outranks_every_other_refusal() {
    XCTAssertEqual(gate("BLOCKED", isDraft: true), .draft)
    XCTAssertEqual(gate("BEHIND", isDraft: true), .draft)
  }

  func test_github_has_not_finished_working_out_mergeability() {
    XCTAssertEqual(gate("UNKNOWN"), .computing)
    XCTAssertEqual(gate("CLEAN", mergeable: "UNKNOWN"), .computing)
    XCTAssertFalse(gate("UNKNOWN").canMerge)
    // Nothing to read back to the user while GitHub is still deciding.
    XCTAssertEqual(GitRepositoryModel.mergeGate(from: "not json"), .computing)
  }

  func test_every_refusal_explains_itself() {
    for gate: GitMergeGate in [.blocked, .behind, .conflicted, .draft, .computing] {
      XCTAssertFalse(gate.reason.isEmpty, "\(gate)")
    }
    XCTAssertEqual(GitMergeGate.ready.reason, "Ready to merge")
  }

  // MARK: - merge methods

  func test_only_the_methods_the_repository_allows_are_offered() {
    let json = """
    {"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":true}
    """
    XCTAssertEqual(GitRepositoryModel.allowedMergeMethods(from: json), [.squash, .rebase])
  }

  func test_a_repository_that_allows_everything_lists_them_in_a_stable_order() {
    let json = """
    {"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true}
    """
    XCTAssertEqual(GitRepositoryModel.allowedMergeMethods(from: json), [.merge, .squash, .rebase])
  }

  func test_unreadable_repository_settings_offer_no_method_rather_than_a_wrong_one() {
    XCTAssertEqual(GitRepositoryModel.allowedMergeMethods(from: "gh: not found"), [])
    XCTAssertEqual(
      GitRepositoryModel.allowedMergeMethods(
        from: """
        {"mergeCommitAllowed":false,"squashMergeAllowed":false,"rebaseMergeAllowed":false}
        """),
      [])
  }

  func test_each_method_carries_the_flag_gh_expects_and_a_label_naming_what_happens() {
    XCTAssertEqual(GitMergeMethod.merge.flag, "--merge")
    XCTAssertEqual(GitMergeMethod.squash.flag, "--squash")
    XCTAssertEqual(GitMergeMethod.rebase.flag, "--rebase")
    XCTAssertEqual(GitMergeMethod.squash.label, "Squash and merge")
  }

  // MARK: - check rollup

  func test_the_rollup_is_the_worst_state_any_check_is_in() {
    let passed = GitCheck(name: "build", state: .passed, url: "")
    let running = GitCheck(name: "test", state: .running, url: "")
    let failed = GitCheck(name: "lint", state: .failed, url: "")
    XCTAssertEqual(GitRepositoryModel.rollup([passed, running, failed]), .failed)
    XCTAssertEqual(GitRepositoryModel.rollup([passed, running]), .running)
    XCTAssertEqual(GitRepositoryModel.rollup([passed]), .passed)
    XCTAssertNil(GitRepositoryModel.rollup([]))
  }

  func test_a_pull_request_without_a_state_field_is_treated_as_open() {
    // The list adds `state` now, but detail JSON and older callers may not.
    let json = """
    [{"number":1,"title":"t","headRefName":"h","baseRefName":"main","url":"u","updatedAt":"d","isDraft":false,"changedFiles":1,"reviewDecision":null}]
    """
    XCTAssertEqual(try GitRepositoryModel.pullRequests(from: json).first?.state, .open)
  }

  func test_pull_request_state_is_read_from_the_json() throws {
    let json = """
    [{"number":1,"title":"a","headRefName":"h","baseRefName":"main","url":"u","updatedAt":"d","isDraft":false,"changedFiles":1,"reviewDecision":null,"state":"OPEN"},
     {"number":2,"title":"b","headRefName":"h","baseRefName":"main","url":"u","updatedAt":"d","isDraft":false,"changedFiles":1,"reviewDecision":null,"state":"MERGED"},
     {"number":3,"title":"c","headRefName":"h","baseRefName":"main","url":"u","updatedAt":"d","isDraft":false,"changedFiles":1,"reviewDecision":null,"state":"CLOSED"}]
    """
    XCTAssertEqual(try GitRepositoryModel.pullRequests(from: json).map(\.state), [.open, .merged, .closed])
  }

  func test_the_list_keeps_open_and_merged_and_drops_closed_without_a_merge() {
    let json = """
    [{"number":1,"title":"a","headRefName":"h","baseRefName":"m","url":"u","updatedAt":"d","isDraft":false,"changedFiles":1,"reviewDecision":null,"state":"OPEN"},
     {"number":2,"title":"b","headRefName":"h","baseRefName":"m","url":"u","updatedAt":"d","isDraft":false,"changedFiles":1,"reviewDecision":null,"state":"MERGED"},
     {"number":3,"title":"c","headRefName":"h","baseRefName":"m","url":"u","updatedAt":"d","isDraft":false,"changedFiles":1,"reviewDecision":null,"state":"CLOSED"}]
    """
    guard case let .list(pulls) = GitRepositoryModel.pullRequestResult(from: json) else { return XCTFail("expected a list") }
    XCTAssertEqual(pulls.map(\.number), [1, 2])
  }

  func test_watch_block_parses_each_check_row_into_its_state() {
    let block = """
    Refreshing checks status every 15 seconds. Press Ctrl+C to quit.

    ios-build\tpending\t0\thttps://x/1\t
    host-tools\tpass\t19s\thttps://x/2\t
    lint\tfail\t12s\thttps://x/3\t
    docs\tskipping\t0\thttps://x/4\t
    """
    let checks = GitRepositoryModel.watchChecks(fromBlock: block)
    XCTAssertEqual(checks.map(\.name), ["ios-build", "host-tools", "lint", "docs"])
    XCTAssertEqual(checks.map(\.state), [.running, .passed, .failed, .skipped])
    XCTAssertEqual(checks[0].url, "https://x/1")
  }

  func test_watch_block_ignores_the_header_and_blank_lines_and_bad_rows() {
    let block = "Refreshing checks status every 20 seconds. Press Ctrl+C to quit.\n\nonly-two\tpass\n"
    // A row without the expected columns is skipped, not force-parsed.
    XCTAssertEqual(GitRepositoryModel.watchChecks(fromBlock: block), [])
  }

  func test_a_watch_stream_yields_each_completed_snapshot_and_keeps_the_partial_tail() {
    let header = "Refreshing checks status every 15 seconds. Press Ctrl+C to quit."
    // Two full snapshots, then a partial third still arriving.
    let buffer = """
    \(header)

    a\tpending\t0\tu\t
    \(header)

    a\tpass\t9s\tu\t
    \(header)

    a\tpa
    """
    let (blocks, remainder) = GitRepositoryModel.watchSnapshots(splitting: buffer)
    XCTAssertEqual(blocks.count, 2)
    XCTAssertEqual(GitRepositoryModel.watchChecks(fromBlock: blocks[1]).first?.state, .passed)
    XCTAssertTrue(remainder.contains("a\tpa"))
  }
}
