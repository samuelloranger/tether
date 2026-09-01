import Foundation

/// What attaching to a session has to do with the client's cached terminal state.
///
/// The pipeline owns exactly ONE emulator, so opening a different session throws
/// the previous one away. The replay cursor, however, is kept per session — and
/// the two used to be decided independently: the emulator for session A was
/// rebuilt empty on the way back to A while A's cursor still pointed at the
/// newest log the client had ever applied. The server then had nothing to
/// replay, so the terminal came up blank with zero scrollback: panning did
/// nothing (there is no history to scroll into) until new output arrived, and
/// everything printed before the switch was unreachable.
///
/// The invariant this type exists to hold: **a rebuilt emulator must always be
/// paired with a rewound replay cursor.**
enum TerminalAttachPlan {
  struct Plan: Equatable {
    /// The cached emulator cannot be reused — start a fresh, empty grid.
    let rebuildEmulator: Bool
    /// Rewind this session's replay cursor so the server resends everything it
    /// still retains, rather than only what arrives from now on.
    let rewindReplayCursor: Bool
  }

  /// - Parameters:
  ///   - emulatorKey: the host-qualified session the cached emulator holds.
  ///   - hasEmulator: whether an emulator is cached at all.
  ///   - key: the host-qualified session being attached to.
  static func plan(emulatorKey: String?, hasEmulator: Bool, key: String) -> Plan {
    let rebuild = emulatorKey != key || !hasEmulator
    return Plan(rebuildEmulator: rebuild, rewindReplayCursor: rebuild)
  }
}
