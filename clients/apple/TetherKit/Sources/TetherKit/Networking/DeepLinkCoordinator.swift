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

public enum DeepLinkResolution: Equatable, Sendable {
  case matched(hostId: String, sessionId: String)
  case unknownHost(identityName: String)
  case invalid
  case queued

  public init(_ ffi: FfiDeepLinkResult) {
    switch ffi {
    case let .matched(hostId: hostId, sessionId: sessionId):
      self = .matched(hostId: hostId, sessionId: sessionId)
    case let .unknownHost(identityName: identityName):
      self = .unknownHost(identityName: identityName)
    case .invalid:
      self = .invalid
    case .queued:
      self = .queued
    }
  }
}

public final class DeepLinkCoordinator: HostProfileProvider, DeepLinkSessionCallback {
  private var profilesProvider: () -> [HostProfileModel]
  private var onSession: (String, String) -> Void
  /// `lazy` because the resolver takes `self` as both provider and callback,
  /// and `self` cannot be passed out of an initializer before every stored
  /// property is initialized — which is what "variable 'self.resolver' used
  /// before being initialized" was reporting. A lazy property is built on
  /// first use, by which point initialization has completed.
  private lazy var resolver: DeepLinkResolver = .init(provider: self, callback: self)

  public init(
    profilesProvider: @escaping () -> [HostProfileModel],
    onSession: @escaping (String, String) -> Void
  ) {
    self.profilesProvider = profilesProvider
    self.onSession = onSession
  }

  public func profiles() -> [FfiHostProfile]? {
    profilesProvider().map {
      FfiHostProfile(
        id: $0.id,
        name: $0.name,
        color: $0.color,
        host: $0.host,
        port: $0.port,
        identityName: $0.identityName,
        order: $0.order,
        scheme: $0.scheme
      )
    }
  }

  public func onSession(hostId: String, sessionId: String) {
    onSession(hostId, sessionId)
  }

  public static func parse(_ url: String) -> SessionDeepLink? {
    guard let ffi = parseSessionDeepLink(url: url) else { return nil }
    return SessionDeepLink(ffi)
  }

  public func handle(_ url: String) -> DeepLinkResolution {
    DeepLinkResolution(resolver.handle(url: url))
  }

  public func applyPending() -> DeepLinkResolution? {
    resolver.applyPending().map(DeepLinkResolution.init)
  }
}
