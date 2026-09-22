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

public struct GitCheck: Equatable, Identifiable, Sendable {
  public enum State: Equatable, Sendable { case passed, failed, running, skipped }

  public let name: String
  public let state: State
  public let url: String

  public var id: String { name }
}

/// Parses machine-readable output from the remote repository commands. Keeping
/// this pure makes the SSH boundary small and gives UI code typed state only.
public enum GitRepositoryModel {
  /// Splits the one workspace command's output. The outer separator is 0x1d,
  /// not 0x1e: the commit format already ends every record with 0x1e, so an
  /// outer 0x1e would be ambiguous against the commits payload itself.
  public static func workspaceSections(
    _ output: String
  ) -> (diff: String, branch: String, commits: String, pullRequests: String)? {
    let parts = output.components(separatedBy: "\u{1D}")
    guard parts.count == 4 else { return nil }
    return (parts[0], parts[1], parts[2], parts[3])
  }

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

  /// "None open" and "could not ask" are different answers; collapsing both
  /// into an empty list made the screen blame a missing GitHub CLI for a
  /// repository that simply had nothing open.
  public enum PullRequestResult: Equatable {
    case list([GitPullRequest])
    case toolMissing
    case failed(String)
  }

  /// Emitted by the host command when `gh` is absent, so that is
  /// distinguishable from gh running and refusing.
  public static let ghMissingSentinel = "__TETHER_NO_GH__"

  public static func pullRequestResult(from output: String) -> PullRequestResult {
    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed == ghMissingSentinel { return .toolMissing }
    if let pulls = try? pullRequests(from: trimmed) { return .list(pulls) }
    // gh puts its reason on the first line.
    let firstLine = trimmed.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? trimmed
    return .failed(firstLine)
  }

  public static func checks(from output: String) -> [GitCheck] {
    guard let raw = try? JSONSerialization.jsonObject(with: Data(output.utf8)) as? [[String: Any]] else {
      return []
    }
    return raw.compactMap { entry in
      guard let name = (entry["name"] as? String) ?? (entry["context"] as? String), !name.isEmpty else {
        return nil
      }
      let url = (entry["detailsUrl"] as? String) ?? (entry["targetUrl"] as? String) ?? ""
      return GitCheck(name: name, state: state(of: entry), url: url)
    }
  }

  private static func state(of entry: [String: Any]) -> GitCheck.State {
    // A StatusContext carries only `state`; a CheckRun is running until its
    // `status` completes, and only then does `conclusion` mean anything.
    let verdict = ((entry["conclusion"] as? String) ?? (entry["state"] as? String) ?? "").uppercased()
    if let status = entry["status"] as? String, status.uppercased() != "COMPLETED" { return .running }
    if verdict.isEmpty { return .running }
    switch verdict {
    case "SUCCESS": return .passed
    case "SKIPPED", "NEUTRAL": return .skipped
    case "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED": return .running
    default: return .failed
    }
  }

  public static func isRunning(_ checks: [GitCheck]) -> Bool {
    checks.contains { $0.state == .running }
  }

  public static func rollup(_ checks: [GitCheck]) -> GitCheck.State? {
    if checks.isEmpty { return nil }
    if checks.contains(where: { $0.state == .failed }) { return .failed }
    if checks.contains(where: { $0.state == .running }) { return .running }
    return .passed
  }

  public static func checkHeadline(_ checks: [GitCheck]) -> String {
    switch rollup(checks) {
    case nil: return "No checks"
    case .failed:
      return "\(checks.filter { $0.state == .failed }.count) failing"
    case .running:
      return "\(checks.filter { $0.state == .running }.count) of \(checks.count) running"
    case .passed, .skipped:
      return "\(checks.count) check\(checks.count == 1 ? "" : "s") passed"
    }
  }
}
