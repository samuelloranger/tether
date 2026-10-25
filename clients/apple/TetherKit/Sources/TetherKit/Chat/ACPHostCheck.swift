import Foundation

/// What a host needs before a chat can start: a `tether-notify` that knows `acp`, and Node for
/// the adapter. One exec reports both, so a new chat never fails silently later.
enum ACPHostCheck {
  enum Problem: Equatable {
    case notifyMissing
    case notifyOutdated
    case nodeMissing
  }

  /// A POSIX script run through `sh -c` so the host's login shell (fish, say) does not matter. It
  /// reports on stdout, because the control exec returns neither stderr nor an exit status.
  static let script = [
    "PATH=\"$HOME/.local/bin:$PATH\"; export PATH",
    "if command -v tether-notify >/dev/null 2>&1; then "
      + "if tether-notify acp ls >/dev/null 2>&1; then echo notify=ok; else echo notify=old; fi; "
      + "else echo notify=missing; fi",
    "if command -v npx >/dev/null 2>&1; then echo node=ok; else echo node=missing; fi",
  ].joined(separator: "; ")

  static var command: String { "sh -c \(shellQuote(script))" }

  /// A line the host did not report is not a problem: only what it said counts.
  static func problems(in output: String) -> [Problem] {
    var found: [Problem] = []
    let lines = output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
    if lines.contains("notify=missing") { found.append(.notifyMissing) }
    if lines.contains("notify=old") { found.append(.notifyOutdated) }
    if lines.contains("node=missing") { found.append(.nodeMissing) }
    return found
  }

  static func message(for problems: [Problem], host: String) -> String? {
    guard !problems.isEmpty else { return nil }
    var parts: [String] = []
    if problems.contains(.notifyMissing) || problems.contains(.notifyOutdated) {
      parts.append("Update tether-notify on \(host). Chat needs a newer version.")
    }
    if problems.contains(.nodeMissing) {
      parts.append("Node.js is required on \(host).")
    }
    return parts.joined(separator: " ")
  }

  /// nil when the host is ready or cannot be checked: a failed connection is reported by the chat's own dial.
  static func verify(host: String, exec: (String) async throws -> String) async -> String? {
    guard let output = try? await exec(command) else { return nil }
    return message(for: problems(in: output), host: host)
  }
}

enum ChatStart: Equatable {
  case ready(ChatRoute)
  case failed(String)
}

extension ChatRoute {
  /// A fresh chat, after the host checks. The failure text is for the new-chat UI as it stands.
  static func start(cwdText: String, host: String, exec: (String) async throws -> String) async -> ChatStart {
    if let message = await ACPHostCheck.verify(host: host, exec: exec) { return .failed(message) }
    guard let route = await fresh(cwdText: cwdText, exec: exec) else {
      return .failed("Couldn't read the host's home folder.")
    }
    return .ready(route)
  }
}
