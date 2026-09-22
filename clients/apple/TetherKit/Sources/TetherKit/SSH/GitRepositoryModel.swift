import Foundation

public struct GitCommit: Equatable, Identifiable, Sendable {
  public let id: String
  public let subject: String
  public let author: String
  public let timestamp: Int
}

public struct GitPullRequest: Codable, Equatable, Identifiable, Sendable {
  public let number: Int
  public let title: String
  public let head: String
  public let base: String
  public let url: String
  public let updatedAt: String
  public let isDraft: Bool
  public let changedFiles: Int
  public let reviewDecision: String?

  public var id: Int { number }

  enum CodingKeys: String, CodingKey {
    case number, title, url, updatedAt, isDraft, changedFiles, reviewDecision
    case head = "headRefName"
    case base = "baseRefName"
  }
}

/// Parses machine-readable output from the remote repository commands. Keeping
/// this pure makes the SSH boundary small and gives UI code typed state only.
public enum GitRepositoryModel {
  public static func branch(from output: String) -> String {
    output.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public static func commits(from output: String) -> [GitCommit] {
    output.split(separator: "\u{1E}").compactMap { record in
      let fields = record.split(separator: "\u{1F}", omittingEmptySubsequences: false)
      guard fields.count == 4, let timestamp = Int(fields[3]) else { return nil }
      return GitCommit(id: String(fields[0]), subject: String(fields[1]), author: String(fields[2]), timestamp: timestamp)
    }
  }

  public static func pullRequests(from output: String) throws -> [GitPullRequest] {
    try JSONDecoder().decode([GitPullRequest].self, from: Data(output.utf8))
  }

  /// What came back from the pull-request query. "None open" and "could not
  /// ask" are different answers and the screen says different things about
  /// them — collapsing both into an empty list is what made it blame a missing
  /// GitHub CLI for every repository that simply had nothing open.
  public enum PullRequestResult: Equatable {
    case list([GitPullRequest])
    case toolMissing
    case failed(String)
  }

  /// Emitted by the host command when `gh` is not installed, so that case is
  /// distinguishable from gh running and refusing.
  public static let ghMissingSentinel = "__TETHER_NO_GH__"

  public static func pullRequestResult(from output: String) -> PullRequestResult {
    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed == ghMissingSentinel { return .toolMissing }
    if let pulls = try? pullRequests(from: trimmed) { return .list(pulls) }
    // gh puts its reason on the first line; the rest is usually a hint we would
    // only truncate badly.
    let firstLine = trimmed.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? trimmed
    return .failed(firstLine)
  }
}
