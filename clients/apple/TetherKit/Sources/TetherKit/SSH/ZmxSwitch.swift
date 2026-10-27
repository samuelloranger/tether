import Foundation

/// How a live SSH terminal moves from one zmx session to another: which bytes
/// go to the PTY, in what order, and how far apart.
enum ZmxSwitch {
  /// Typing only reaches a session that is already attached; a redial has no
  /// PTY to type into, so it is not one of these.
  enum Typing: Equatable { case detachThenAttach, attachInPlace }

  enum Strategy: Equatable {
    case type(Typing)
    case redial
  }

  /// zmx's client-detach key: the zmx client consumes it, so the program inside keeps running.
  static let detachKey = "\u{1C}"

  /// At a bare shell (the session's program exited) the detach key lands as a literal;
  /// kill-line wipes it before the attach.
  static let killLine = "\u{15}"

  /// zmx drops whatever shares a read with the detach key. Measured: in the same write the
  /// attach is always lost, a few ms later it always lands; this is margin over that.
  static let settleNanoseconds: UInt64 = 250_000_000

  /// A CLI agent renders inline, not on the alt-screen, so a typed `zmx attach` lands in its
  /// prompt: with a client attached, detach first and attach from the shell underneath.
  static func strategy(connected: Bool, attached: Bool) -> Strategy {
    guard connected else { return .redial }
    return .type(attached ? .detachThenAttach : .attachInPlace)
  }

  /// `command` (already quoted for a shell) runs instead of a login shell when the session is new.
  static func attachCommand(zmx: String, name: String, command: String? = nil) -> String {
    "\(zmx) attach \(shellQuote(name))\(command.map { " " + $0 } ?? "")\n"
  }

  /// The PTY writes the switch performs, in order. More than one element means
  /// they must reach the host as separate writes, `settleNanoseconds` apart.
  static func writes(typing: Typing, zmx: String, name: String, command: String? = nil) -> [String] {
    let attach = attachCommand(zmx: zmx, name: name, command: command)
    switch typing {
    case .attachInPlace:
      return [attach]
    case .detachThenAttach:
      return [detachKey, killLine + attach]
    }
  }

  /// Resumes a Claude Code conversation in `cwd`, then leaves a login shell when it exits. POSIX
  /// `sh` runs it, so the line typed at the host's prompt is the same in bash, zsh or fish.
  static func resumeCommand(sessionId: String, cwd: String) -> String {
    let script = #"cd "${1:-$HOME}" && claude --resume "$2"; exec "${SHELL:-/bin/sh}" -l"#
    return "sh -c \(shellQuote(script)) sh \(shellQuote(cwd)) \(shellQuote(sessionId))"
  }
}
