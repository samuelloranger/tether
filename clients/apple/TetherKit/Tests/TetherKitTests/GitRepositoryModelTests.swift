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

  func test_parses_open_pull_requests_from_gh_json() throws {
    let json = """
    [{"number":196,"title":"Native interactions","headRefName":"feat/native","baseRefName":"main","url":"https://example.test/pr/196","updatedAt":"2026-09-22T01:00:00Z","isDraft":false,"changedFiles":12,"reviewDecision":"REVIEW_REQUIRED"}]
    """

    XCTAssertEqual(try GitRepositoryModel.pullRequests(from: json), [
      GitPullRequest(number: 196, title: "Native interactions", head: "feat/native", base: "main", url: "https://example.test/pr/196", updatedAt: "2026-09-22T01:00:00Z", isDraft: false, changedFiles: 12, reviewDecision: "REVIEW_REQUIRED")
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
}
