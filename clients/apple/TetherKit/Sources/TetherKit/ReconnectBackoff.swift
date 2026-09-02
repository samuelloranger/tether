import Foundation

/// Reconnect timing — a Swift port of `backoff_delay` / `retry_after_close` in
/// `crates/tether-core/src/terminal_session_logic.rs`. Kept byte-identical to the
/// Rust so the native and desktop clients back off on the same curve.
public enum ReconnectBackoff {
  /// A connection that lived at least this long is "healthy": its drop starts a
  /// fresh backoff instead of inheriting the previous outage's delay.
  public static let healthyMs: Int64 = 10_000

  /// Exponential reconnect delay (ms) with jitter in the upper half of the band.
  /// `randomUnit` is clamped to [0,1). Mirrors Rust `backoff_delay`.
  public static func delayMs(attempt: UInt32, randomUnit: Double) -> UInt64 {
    let exponent = min(attempt, 5)
    let base = min(1_000 * (UInt64(1) << exponent), 30_000)
    let unit = min(max(randomUnit, 0.0), 1.0)
    let half = base / 2
    let jitter = UInt64((unit * Double(half)).rounded(.down))
    return half + min(jitter, half - 1)
  }

  /// Resets the retry counter to 0 once a connection has lived long enough to be
  /// healthy, otherwise keeps it. Mirrors Rust `retry_after_close`.
  public static func retryAfterClose(
    retry: UInt32,
    openedAtMs: Int64,
    nowMs: Int64,
    healthyMs: Int64 = ReconnectBackoff.healthyMs
  ) -> UInt32 {
    let lived = openedAtMs > 0 ? max(0, nowMs - openedAtMs) : 0
    if openedAtMs > 0 && lived >= healthyMs {
      return 0
    }
    return retry
  }
}
