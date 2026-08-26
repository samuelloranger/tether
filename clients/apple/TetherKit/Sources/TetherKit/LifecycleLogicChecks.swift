import Foundation

/// Reference assertions for a future XCTest target. Pure logic only —
/// call `ResumeLogicChecks.allPass()` / `SessionActivityChecks.allPass()` from
/// tests; no XCTest dependency here.
public enum ResumeLogicChecks {
  public static func allPass() -> Bool {
    let now: Int64 = 1_000_000
    let closed = ResumeLogic.action(open: false, lastSeenMs: now, nowMs: now) == .reconnect
      && ResumeLogic.action(open: false, lastSeenMs: 0, nowMs: now) == .reconnect
    let stale = ResumeLogic.action(
      open: true,
      lastSeenMs: now - ResumeLogic.staleMs - 1,
      nowMs: now
    ) == .close
    let healthy = ResumeLogic.action(open: true, lastSeenMs: now - 1000, nowMs: now) == .none
      && ResumeLogic.action(open: true, lastSeenMs: now, nowMs: now) == .none
    return closed && stale && healthy
  }
}

public enum SessionActivityChecks {
  public static func allPass() -> Bool {
    let stoppedWins =
      SessionActivityLogic.dotKey(status: "stopped", activity: "working", live: true) == .stopped
    let mapped =
      SessionActivityLogic.dotKey(status: "running", activity: "waiting", live: false) == .waiting
      && SessionActivityLogic.dotKey(status: "running", activity: "working", live: false) == .working
      && SessionActivityLogic.dotKey(status: "running", activity: "idle", live: true) == .idle
    let fallback =
      SessionActivityLogic.dotKey(status: "running", activity: nil, live: true) == .working
      && SessionActivityLogic.dotKey(status: "running", activity: nil, live: false) == .idle
    let labels =
      SessionActivityLogic.label(.waiting) == "needs input"
      && SessionActivityLogic.label(.working) == "working"
      && SessionActivityLogic.label(.idle) == "idle"
      && SessionActivityLogic.label(.stopped) == "stopped"
    let a11y = SessionActivityLogic.accessibilityLabel(
      title: "Build agent",
      status: "running",
      activity: "waiting",
      live: false
    ) == "Terminal Build agent, needs input"
    return stoppedWins && mapped && fallback && labels && a11y
  }
}
