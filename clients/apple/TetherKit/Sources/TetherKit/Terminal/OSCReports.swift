import Foundation

/// A program's progress report (OSC 9;4), as the header bar shows it.
public struct TerminalProgress: Equatable, Sendable {
  public enum State: Equatable, Sendable { case normal, error, indeterminate, warning }
  public var state: State
  /// 0...100. Meaningless while indeterminate.
  public var percent: Int

  public init(state: State, percent: Int) {
    self.state = state
    self.percent = percent
  }
}

/// What the running programs have said about the session: its title (OSC 0/2), its working
/// directory (OSC 7) and its progress (OSC 9;4).
public struct TerminalReport: Equatable, Sendable {
  public var title: String?
  /// Absolute path on the host. The host part of the OSC 7 URL is not checked, so it is a
  /// hint: a shell that ssh'd onward reports the other machine's directory.
  public var cwd: String?
  public var progress: TerminalProgress?

  public init(title: String? = nil, cwd: String? = nil, progress: TerminalProgress? = nil) {
    self.title = title
    self.cwd = cwd
    self.progress = progress
  }

  public static let empty = TerminalReport()
}

/// Reads OSC 0/2, 7, 9;4 and 52 from the events of the engine's `OSCScanner`. Text a program
/// prints is untrusted: titles lose control and bidi characters, and a clipboard query is
/// never answered, so nothing here can read the device's clipboard.
struct OSCReports {
  private(set) var report = TerminalReport.empty
  /// OSC 52 texts not yet taken, oldest first.
  private var clipboard: [String] = []

  static let titleLimit = 128
  static let pathLimit = 4096
  /// Decoded OSC 52 text cap; the scanner keeps enough of the base64 to reach it.
  static let clipboardLimit = 75_000

  mutating func apply(_ event: OSCScanner.Event) {
    switch event {
    case .reset:
      report.progress = nil
    case let .osc(code, body, _):
      switch code {
      case "0", "2": report.title = Self.title(body)
      case "7": if let path = Self.path(fromURL: body) { report.cwd = path }
      case "9": applyProgress(body)
      case "52": if let text = Self.clipboardText(body) { clipboard.append(text) }
      case "133":
        // The prompt is back: whatever reported progress has finished or died.
        if body.first == UInt8(ascii: "A") { report.progress = nil }
      default: break
      }
    }
  }

  mutating func takeClipboard() -> [String] {
    defer { clipboard.removeAll() }
    return clipboard
  }

  mutating func discardClipboard() { clipboard.removeAll() }

  /// A report carried over from an engine this one replaces, whose output may be gone from
  /// the buffer this one was rebuilt from. Anything this engine saw itself is newer.
  mutating func adopt(_ carried: TerminalReport) {
    report.title = report.title ?? carried.title
    report.cwd = report.cwd ?? carried.cwd
  }

  // MARK: - Parsing

  static func title(_ body: [UInt8]) -> String? {
    let cleaned = String(decoding: body, as: UTF8.self).unicodeScalars.filter { scalar in
      switch scalar.properties.generalCategory {
      case .control, .format: return false
      default: return true
      }
    }
    let text = String(String.UnicodeScalarView(cleaned)).trimmingCharacters(in: .whitespaces)
    return text.isEmpty ? nil : String(text.prefix(titleLimit))
  }

  static func path(fromURL body: [UInt8]) -> String? {
    let text = String(decoding: body, as: UTF8.self)
    guard text.hasPrefix("file://") else { return nil }
    let rest = text.dropFirst("file://".count)
    guard let slash = rest.firstIndex(of: "/"),
          let path = String(rest[slash...]).removingPercentEncoding,
          path.count <= pathLimit,
          !path.unicodeScalars.contains(where: { $0.properties.generalCategory == .control })
    else { return nil }
    return path
  }

  static func clipboardText(_ body: [UInt8]) -> String? {
    let text = String(decoding: body, as: UTF8.self)
    guard let separator = text.firstIndex(of: ";") else { return nil }
    var payload = text[text.index(after: separator)...].filter { !$0.isWhitespace }
    // "?" asks for the clipboard's contents; an empty payload would clear it. Neither is honored.
    guard !payload.isEmpty, payload != "?" else { return nil }
    while payload.count % 4 != 0 { payload.append("=") }
    guard let data = Data(base64Encoded: payload), data.count <= clipboardLimit,
          let decoded = String(data: data, encoding: .utf8), !decoded.isEmpty
    else { return nil }
    return decoded
  }

  private mutating func applyProgress(_ body: [UInt8]) {
    let fields = String(decoding: body, as: UTF8.self).split(separator: ";", omittingEmptySubsequences: false)
    // Other OSC 9 bodies are desktop notifications.
    guard fields.count >= 2, fields[0] == "4", let raw = Int(fields[1]) else { return }
    let percent = fields.count > 2 ? Int(fields[2]).map { min(max($0, 0), 100) } : nil
    let state: TerminalProgress.State
    switch raw {
    case 0: report.progress = nil; return
    case 1: state = .normal
    case 2: state = .error
    case 3: state = .indeterminate
    case 4: state = .warning
    default: return
    }
    report.progress = TerminalProgress(state: state, percent: percent ?? report.progress?.percent ?? 0)
  }
}
