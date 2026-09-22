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
}
