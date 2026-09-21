import Foundation
import TetherFFIBindings

public struct SessionDeepLink: Equatable, Sendable {
  public var sessionId: String
  public var identityName: String

  public init?(_ ffi: FfiSessionDeepLink) {
    sessionId = ffi.sessionId
    identityName = ffi.identityName
  }
}

public enum DeepLinkCoordinator {
  public static func parse(_ url: String) -> SessionDeepLink? {
    guard let ffi = parseSessionDeepLink(url: url) else { return nil }
    return SessionDeepLink(ffi)
  }
}
