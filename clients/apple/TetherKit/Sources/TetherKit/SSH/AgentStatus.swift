import Foundation

/// One zmx session's agent state, as `tether-notify status` reports it.
public struct AgentStatus: Equatable, Sendable, Identifiable {
  public enum State: String, Sendable { case working, waiting, done }

  public var session: String
  public var agent: String
  public var state: State
  public var since: Date
  public var updated: Date
  public var message: String
  public var link: String

  public var id: String { session }

  /// The host label this host's pushes carry — how a foreground push is matched to the open host.
  public var hostLabel: String? { SessionDeepLink.parse(link)?.identityName }

  /// `nil` stays until acted on: a question must not disappear on its own.
  public var bannerLifetime: TimeInterval? { state == .done ? 6 : nil }

  public init(session: String, agent: String, state: State, since: Date, updated: Date, message: String, link: String) {
    self.session = session
    self.agent = agent
    self.state = state
    self.since = since
    self.updated = updated
    self.message = message
    self.link = link
  }

  public static func parse(_ output: String) -> [AgentStatus] {
    struct Row: Decodable {
      let session: String
      let agent: String?
      let state: String
      let since: Double?
      let updated: Double?
      let message: String?
      let link: String?
    }
    guard let rows = try? JSONDecoder().decode([Row].self, from: Data(output.utf8)) else { return [] }
    return rows.compactMap { row in
      guard !row.session.isEmpty, let state = State(rawValue: row.state) else { return nil }
      return AgentStatus(
        session: row.session, agent: row.agent ?? "", state: state,
        since: Date(timeIntervalSince1970: row.since ?? 0),
        updated: Date(timeIntervalSince1970: row.updated ?? 0),
        message: row.message ?? "", link: row.link ?? "")
    }
  }

  public static func ageLabel(since: Date, now: Date) -> String {
    let seconds = max(0, now.timeIntervalSince(since))
    switch seconds {
    case ..<60: return "now"
    case ..<3600: return "\(Int(seconds / 60))m"
    case ..<86400: return "\(Int(seconds / 3600))h"
    default: return "\(Int(seconds / 86400))d"
    }
  }
}

public enum AgentStatusChanges {
  /// `old == nil` is the first read after a connect: a baseline, never an alert.
  public static func alerts(old: [String: AgentStatus]?, new: [AgentStatus], current: String) -> [AgentStatus] {
    guard let old else { return [] }
    return new.filter { status in
      guard status.session != current, status.state != .working else { return false }
      guard let before = old[status.session] else { return true }
      return before.state != status.state || before.since != status.since
    }
  }
}
