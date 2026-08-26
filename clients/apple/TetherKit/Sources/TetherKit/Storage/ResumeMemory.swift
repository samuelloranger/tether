import Foundation

/// Remembers which host and terminal were open, so a cold launch can return to
/// them.
///
/// Session ids are only unique per host — two servers both call their first
/// session `default` — so the remembered session is stored under its host and
/// read back with that host, rather than as one global id that would resolve to
/// the wrong terminal after a host switch.
public enum ResumeMemory {
  private enum Key {
    static let host = "tether.lastHostId"
    static func session(_ hostId: String) -> String { "tether.lastSessionId.\(hostId)" }
  }

  private static var defaults: UserDefaults { .standard }

  public static func rememberHost(_ hostId: String?) {
    guard let hostId else { return }
    defaults.set(hostId, forKey: Key.host)
  }

  public static func rememberedHost() -> String? {
    defaults.string(forKey: Key.host)
  }

  /// A nil session is not written down. Clearing on every transient nil — a
  /// killed session, a dropped host — would erase the memory the next launch
  /// needs; the id is only ever superseded by another id, or ignored at restore
  /// because the server no longer lists it.
  public static func rememberSession(_ sessionId: String?, forHost hostId: String?) {
    guard let sessionId, let hostId else { return }
    defaults.set(sessionId, forKey: Key.session(hostId))
  }

  public static func rememberedSession(forHost hostId: String) -> String? {
    defaults.string(forKey: Key.session(hostId))
  }
}
