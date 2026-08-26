import Foundation

/// Compact age of a timestamp, e.g. `4s`, `12m`, `3h`, `2d`.
/// Port of `apps/desktop/src/sessionStrip.ts` `relativeSince`.
public enum SessionStrip {
  public static func relativeSince(
    _ raw: String?,
    nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
  ) -> String {
    guard let raw, !raw.isEmpty else { return "—" }
    // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker;
    // parsed as-is that reads as local time and every age comes out hours wrong.
    let normalised = raw.contains("T") ? raw : raw.replacingOccurrences(of: " ", with: "T")
    let withZ = normalised.hasSuffix("Z") ? normalised : normalised + "Z"
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    guard let date = formatter.date(from: withZ) ?? sqliteFormatter.date(from: raw) else {
      return "—"
    }
    let thenMs = Int64(date.timeIntervalSince1970 * 1000)
    let seconds = max(0, Int((nowMs - thenMs) / 1000))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    return "\(hours / 24)d"
  }

  private static let sqliteFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(secondsFromGMT: 0)
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f
  }()
}
