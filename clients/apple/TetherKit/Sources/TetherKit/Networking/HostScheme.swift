import Foundation

/// Per-host transport scheme (`http`/`ws` vs `https`/`wss`), so REST and Noise
/// agree: a raw IP is plaintext, a TLS-fronted domain is `https`. A hardcoded
/// scheme can serve only one. Captured at pairing; UserDefaults-backed.
public enum HostScheme {
  private static let key = "tether.host.schemes"

  private static func map() -> [String: String] {
    (UserDefaults.standard.dictionary(forKey: key) as? [String: String]) ?? [:]
  }

  /// Stored scheme, else a port guess (443/8443 → `https`) for pre-existing hosts.
  public static func scheme(forHost id: String, port: String) -> String {
    map()[id] ?? ((port == "443" || port == "8443") ? "https" : "http")
  }

  public static func isSecure(forHost id: String, port: String) -> Bool {
    scheme(forHost: id, port: port) == "https"
  }

  public static func record(_ scheme: String, forHost id: String) {
    let s = scheme.lowercased()
    var m = map()
    m[id] = (s == "https" || s == "wss") ? "https" : "http"
    UserDefaults.standard.set(m, forKey: key)
  }

  public static func forget(_ id: String) {
    var m = map()
    m.removeValue(forKey: id)
    UserDefaults.standard.set(m, forKey: key)
  }
}
