import Foundation

/// Which terminal a cold launch should open.
///
/// The app used to open none. `bootstrap()` restored the host but never a
/// session, and nothing wrote the last session id down, so force-quitting left
/// the user staring at an empty pane with their shells still running on the
/// server — the one thing Tether exists to prevent.
public enum SessionResume {
  /// The remembered session when it is still alive on the server, otherwise the
  /// first one the host reports.
  ///
  /// Falling back to the first rather than to nothing is deliberate: a session
  /// the user cannot see is a session they will not know is running. nil means
  /// the host genuinely has no sessions, which is the empty state's job.
  public static func pick(remembered: String?, available: [String]) -> String? {
    if let remembered, available.contains(remembered) { return remembered }
    return available.first
  }

  /// The sessions a cold launch is allowed to open.
  ///
  /// Running only. `/api/sessions` lists stopped sessions too, and opening the
  /// socket for an id calls `startSession` on the server — so restoring onto a
  /// stopped row would spawn a fresh shell under it and resurrect a terminal the
  /// user had deliberately killed. Launching the app must never start anything.
  public static func restorable(_ sessions: [(id: String, status: String)]) -> [String] {
    sessions.filter { $0.status == "running" }.map(\.id)
  }

  /// Which host a cold launch should open, under the same rule: the remembered
  /// one while it still exists, otherwise the first paired host.
  public static func pickHost(remembered: String?, available: [String]) -> String? {
    if let remembered, available.contains(remembered) { return remembered }
    return available.first
  }
}
