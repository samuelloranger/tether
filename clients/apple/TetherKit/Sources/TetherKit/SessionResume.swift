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

  /// Which host a cold launch should open, under the same rule: the remembered
  /// one while it still exists, otherwise the first paired host.
  public static func pickHost(remembered: String?, available: [String]) -> String? {
    if let remembered, available.contains(remembered) { return remembered }
    return available.first
  }
}
