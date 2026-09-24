import Foundation

public struct SessionDeepLink: Equatable, Sendable {
  public var sessionId: String
  public var identityName: String

  public init(sessionId: String, identityName: String) {
    self.sessionId = sessionId
    self.identityName = identityName
  }

  /// `tether://session/<id>?host=<identity>`; anything else is nil.
  public static func parse(_ url: String) -> SessionDeepLink? {
    let scheme = "tether://"
    guard url.hasPrefix(scheme) else { return nil }
    var rest = url.dropFirst(scheme.count)
    if let hash = rest.firstIndex(of: "#") { rest = rest[..<hash] }
    guard let mark = rest.firstIndex(of: "?") else { return nil }
    let location = rest[..<mark]
    let query = rest[rest.index(after: mark)...]
    let prefix = "session/"
    guard location.hasPrefix(prefix) else { return nil }
    let sessionId = String(location.dropFirst(prefix.count))
    guard !sessionId.isEmpty else { return nil }
    let identity = query.split(separator: "&").lazy.compactMap { parameter -> String? in
      guard let equals = parameter.firstIndex(of: "="), parameter[..<equals] == "host" else { return nil }
      return decodeQueryComponent(parameter[parameter.index(after: equals)...])
    }.first
    guard let identity, !identity.isEmpty else { return nil }
    return SessionDeepLink(sessionId: sessionId, identityName: identity)
  }

  private static func decodeQueryComponent(_ value: Substring) -> String? {
    let bytes = Array(value.utf8)
    var decoded: [UInt8] = []
    decoded.reserveCapacity(bytes.count)
    var index = 0
    while index < bytes.count {
      switch bytes[index] {
      case UInt8(ascii: "+"):
        decoded.append(UInt8(ascii: " "))
      case UInt8(ascii: "%") where index + 2 < bytes.count:
        guard let high = hexValue(bytes[index + 1]), let low = hexValue(bytes[index + 2]) else { return nil }
        decoded.append(high << 4 | low)
        index += 2
      default:
        decoded.append(bytes[index])
      }
      index += 1
    }
    return String(bytes: decoded, encoding: .utf8)
  }

  private static func hexValue(_ byte: UInt8) -> UInt8? {
    switch byte {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
    case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
    case UInt8(ascii: "A")...UInt8(ascii: "F"): return byte - UInt8(ascii: "A") + 10
    default: return nil
    }
  }
}

public enum DeepLinkCoordinator {
  public static func parse(_ url: String) -> SessionDeepLink? {
    SessionDeepLink.parse(url)
  }
}

public enum DeepLinkRoute: Equatable, Sendable {
  /// The open terminal is on the link's host: switch sessions in place.
  case switchSession(String)
  case open(profileID: String, session: String)
  case none
}

extension SessionDeepLink {
  /// The link's host is the label the hook stamped (a hostname by default), not a saved
  /// machine's name, so it is matched against both: the open host's reported labels first,
  /// then a saved machine's name, its address, or its address's first DNS label.
  public func route(
    profiles: [SSHHostProfile], currentProfileID: String?, currentHostLabels: Set<String>
  ) -> DeepLinkRoute {
    if currentProfileID != nil, currentHostLabels.contains(identityName) { return .switchSession(sessionId) }
    let label = identityName.lowercased()
    let match = profiles.first { $0.name.lowercased() == label }
      ?? profiles.first { $0.host.lowercased() == label }
      ?? profiles.first { $0.host.lowercased().split(separator: ".").first.map(String.init) == label }
    guard let match else { return .none }
    return match.id == currentProfileID ? .switchSession(sessionId) : .open(profileID: match.id, session: sessionId)
  }
}
