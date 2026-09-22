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

  /// zmx's client-detach key. The zmx *client* consumes it, so the program
  /// inside the session — a CLI agent mid-task — never sees it and keeps
  /// running on the host while we leave.
  static let detachKey = "\u{1C}"

  /// Kill-line, sent ahead of the attach command: when the PTY was already at a
  /// bare shell (the session's program had exited), the detach key reached the
  /// line editor as a literal and has to be wiped first.
  static let killLine = "\u{15}"

  /// The zmx client discards whatever arrives in the same read as the detach
  /// key, so the attach command is a separate write once the client is gone.
  /// Measured against a host: carried in the same write the attach is lost
  /// every time; a few milliseconds later it lands every time. This is the
  /// margin over that.
  static let settleNanoseconds: UInt64 = 250_000_000

  /// Typing `zmx attach <name>` only switches when a shell is reading the PTY.
  /// A CLI agent renders inline rather than on the alt-screen, so "no
  /// full-screen program" never meant "a shell has the keyboard" — the command
  /// went into the agent's prompt instead. With a client attached, detach it
  /// first and attach from the shell underneath. A host with no session yet is
  /// a bare login shell, which takes the command directly. Disconnected, there
  /// is nothing to type into at all.
  static func strategy(connected: Bool, attached: Bool) -> Strategy {
    guard connected else { return .redial }
    return .type(attached ? .detachThenAttach : .attachInPlace)
  }

  static func attachCommand(zmx: String, name: String) -> String {
    "\(zmx) attach \(shellQuote(name))\n"
  }

  /// The PTY writes the switch performs, in order. More than one element means
  /// they must reach the host as separate writes, `settleNanoseconds` apart.
  static func writes(typing: Typing, zmx: String, name: String) -> [String] {
    switch typing {
    case .attachInPlace:
      return [attachCommand(zmx: zmx, name: name)]
    case .detachThenAttach:
      return [detachKey, killLine + attachCommand(zmx: zmx, name: name)]
    }
  }
}
