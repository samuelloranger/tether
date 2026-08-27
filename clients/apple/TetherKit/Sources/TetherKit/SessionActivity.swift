import Foundation
import SwiftUI

/// Client-side model for the server's per-session activity classification
/// (`working` / `waiting` / `idle`). Pure helpers so badge colour and a11y
/// labels are unit-testable without a view. Port of `apps/mobile/src/activity.ts`.
public enum SessionActivityDot: String, Equatable, Sendable {
  case stopped
  case waiting
  case working
  case done
  case idle
}

public enum SessionActivityLogic {
  /// Recency window matching `isRecentlyActive` in the RN client (10s).
  public static let recentOutputMs: Int64 = 10_000

  /// Which drawer dot to show. `live` is the pre-existing recency fallback used
  /// when the server reports no classification (e.g. right after a restart).
  public static func dotKey(
    status: String,
    activity: String?,
    live: Bool
  ) -> SessionActivityDot {
    if status == "stopped" { return .stopped }
    switch activity {
    case "waiting": return .waiting
    case "working": return .working
    case "done": return .done
    case "idle": return .idle
    default: return live ? .working : .idle
    }
  }

  public static func label(_ key: SessionActivityDot) -> String {
    switch key {
    case .stopped: return "stopped"
    case .waiting: return "needs input"
    case .working: return "working"
    case .done: return "finished"
    case .idle: return "idle"
    }
  }

  public static func accessibilityLabel(
    title: String,
    status: String,
    activity: String?,
    live: Bool
  ) -> String {
    let key = dotKey(status: status, activity: activity, live: live)
    return "Terminal \(title), \(label(key))"
  }

  /// SQLite `CURRENT_TIMESTAMP` is UTC `"YYYY-MM-DD HH:MM:SS"`; treat as UTC.
  public static func isRecentlyActive(
    lastOutputAt: String?,
    nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
  ) -> Bool {
    guard let raw = lastOutputAt, !raw.isEmpty else { return false }
    let normalized = raw.contains("T") ? raw : raw.replacingOccurrences(of: " ", with: "T")
    let withZ = normalized.hasSuffix("Z") ? normalized : normalized + "Z"
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    // Fall back to a formatter that accepts fractional seconds / no seconds edge cases.
    guard let date = formatter.date(from: withZ)
      ?? Self.sqliteTimestampFormatter.date(from: raw)
    else { return false }
    let thenMs = Int64(date.timeIntervalSince1970 * 1000)
    return nowMs - thenMs < recentOutputMs
  }

  /// Dot fill using existing `TetherColors` / the same `.green` the drawer
  /// already uses for host-online — no new palette entries.
  public static func color(for key: SessionActivityDot) -> Color {
    switch key {
    case .stopped:
      TetherColors.textFaint
    case .waiting:
      TetherColors.heatWaiting
    case .working:
      TetherColors.heatWorking
    case .done:
      TetherColors.heatDone
    case .idle:
      TetherColors.heatCool
    }
  }

  private static let sqliteTimestampFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(secondsFromGMT: 0)
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f
  }()
}
