import Foundation

/// What to do with a session socket when the app returns to the foreground.
///
/// iOS invalidates sockets while suspended. Without a resume pass, a closed
/// socket waits out its backoff and a half-open one waits on a keepalive
/// sweep — both leave the terminal silently dead while the user is looking
/// at it. Port of `apps/mobile/src/resume.ts`.
public enum ResumeAction: Equatable, Sendable {
  /// Closed (or never opened): reconnect now instead of waiting out backoff.
  case reconnect
  /// Open but silent across the suspension: likely half-open — force a close
  /// (and reconnect; the native client has no separate onClose reconnect path).
  case close
  /// Open and recently heard from — leave it alone.
  case none
}

public enum ResumeLogic {
  /// Milliseconds of silence after which an "open" socket is treated as dead.
  public static let staleMs: Int64 = 15_000

  public static func action(
    open: Bool,
    lastSeenMs: Int64,
    nowMs: Int64,
    staleMs: Int64 = ResumeLogic.staleMs
  ) -> ResumeAction {
    if !open { return .reconnect }
    return nowMs - lastSeenMs > staleMs ? .close : .none
  }
}
