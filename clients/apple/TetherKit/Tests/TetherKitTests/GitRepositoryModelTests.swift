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
}
