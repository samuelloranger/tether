import Foundation

/// One rate-limit window from the account usage endpoint, shown as a gauge in
/// the composer's info strip. `utilization` is a percentage (0–100).
public struct UsageWindow: Equatable, Sendable {
  public var utilization: Int
  /// ISO-8601 instant the window resets, for a future tooltip; may be absent.
  public var resetsAt: String?

  public init(utilization: Int, resetsAt: String? = nil) {
    self.utilization = utilization
    self.resetsAt = resetsAt
  }
}

/// Ephemeral account/session status for the info strip: the active model and
/// the 5-hour / 7-day usage windows. Every field is optional — the strip shows
/// only what has arrived, and hides entirely until at least one datum is known.
/// Fed by a future `agent.status` frame (server support pending); until then it
/// stays nil and the strip renders only the live session token/cost total.
public struct AgentStatus: Equatable, Sendable {
  public var model: String?
  public var fiveHour: UsageWindow?
  public var sevenDay: UsageWindow?

  public init(
    model: String? = nil, fiveHour: UsageWindow? = nil, sevenDay: UsageWindow? = nil
  ) {
    self.model = model
    self.fiveHour = fiveHour
    self.sevenDay = sevenDay
  }
}
