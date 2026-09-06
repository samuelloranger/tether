import Foundation

/// Per-host transport (`http`/`ws` vs `https`/`wss`), so REST and Noise agree: a
/// raw IP is plaintext, a TLS-fronted domain is `https`. The scheme is captured
/// at pairing and stored on the HostProfile; `nil` on profiles saved before the
/// field existed, where the port is the fallback (443/8443 → `https`).
public enum HostScheme {
  /// Recorded scheme, else a port guess for pre-field hosts.
  public static func resolve(_ scheme: String?, port: String) -> String {
    if scheme == "http" || scheme == "https" { return scheme! }
    return (port == "443" || port == "8443") ? "https" : "http"
  }

  public static func isSecure(_ scheme: String?, port: String) -> Bool {
    resolve(scheme, port: port) == "https"
  }
}
