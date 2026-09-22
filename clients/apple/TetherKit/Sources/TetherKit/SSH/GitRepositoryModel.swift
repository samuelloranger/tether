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
}
