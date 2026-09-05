import Foundation
import OSLog
import Security

#if canImport(UIKit)
import UIKit
import UserNotifications
#endif

/// Requests notification permission, obtains the APNs device token, and
/// registers it with every paired host profile.
///
/// Failures are logged and swallowed — push must never block or throw into UI.
@MainActor
public final class PushRegistrar {
  private static let log = Logger(subsystem: "dev.tether.app", category: "push")
  private static let tokenDefaultsKey = "tether_push_device_token"
  private static let secretAccount = "tether_push_secret"
  private static let keychainService = "dev.tether.app"
  private static let keyBytes = 32

  private let hostStore: HostStoreAdapter
  private let defaults: UserDefaults
  private let noiseClient = NoiseSessionClient()

  public init(
    hostStore: HostStoreAdapter = HostStoreAdapter(),
    defaults: UserDefaults = .standard
  ) {
    self.hostStore = hostStore
    self.defaults = defaults
  }

  private lazy var tokenCache = NoiseTokenCache(mint: { [weak self] hostId in
    guard
      let self,
      let host = (try? self.hostStore.list())?.first(where: { $0.id == hostId }),
      let url = SessionStore.noiseBaseURL(for: host)
    else { throw HostClientError.invalidURL }
    return try await self.noiseClient.requestToken(hostId: hostId, url: url)
  })

  private func tokenClient(for host: HostProfileModel) -> NativeHostClient {
    NativeHostClient(
      profile: host,
      bearerSource: NoiseTokenBearerSource(cache: tokenCache, hostId: host.id)
    )
  }

  /// Persisted APNs token (lowercase 64-hex), if any.
  public var storedDeviceToken: String? {
    defaults.string(forKey: Self.tokenDefaultsKey)
  }

  /// Ask for alert/sound/badge, then `registerForRemoteNotifications`. If a
  /// token is already persisted, also register with current hosts immediately
  /// so a newly-added host gets covered before the next APNs callback.
  public func start() {
    #if canImport(UIKit)
    Task {
      let center = UNUserNotificationCenter.current()
      do {
        let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        guard granted else {
          Self.log.info("Push permission not granted")
          return
        }
      } catch {
        Self.log.error("Push authorization failed: \(error.localizedDescription, privacy: .public)")
        return
      }
      UIApplication.shared.registerForRemoteNotifications()
      await registerStoredTokenWithAllHosts()
    }
    #endif
  }

  /// Called from `UIApplicationDelegate.didRegisterForRemoteNotifications`.
  public func handleDeviceToken(_ deviceToken: Data) {
    guard let hex = Self.normalizeDeviceToken(deviceToken) else {
      Self.log.error("APNs token was not 32 bytes (got \(deviceToken.count))")
      return
    }
    defaults.set(hex, forKey: Self.tokenDefaultsKey)
    Task { await register(deviceToken: hex) }
  }

  public func handleRegistrationFailure(_ error: Error) {
    Self.log.error(
      "APNs registration failed: \(error.localizedDescription, privacy: .public)"
    )
  }

  /// Re-POST the stored token to every paired host. Safe to call
  /// after adding a host mid-session.
  public func registerStoredTokenWithAllHosts() async {
    guard let token = storedDeviceToken else { return }
    await register(deviceToken: token)
  }

  /// Best-effort unregister before a host profile is removed locally.
  public func unregisterFromHost(hostId: String) async {
    guard let token = storedDeviceToken else { return }
    guard
      let hosts = try? hostStore.list(),
      let profile = hosts.first(where: { $0.id == hostId })
    else { return }
    let client = tokenClient(for: profile)
    do {
      try await client.unregisterPushDevice(deviceToken: token)
    } catch {
      Self.log.error(
        "Push unregister failed for \(hostId, privacy: .public): \(error.localizedDescription, privacy: .public)"
      )
    }
  }

  private func register(deviceToken: String) async {
    let secretKey: String
    do {
      secretKey = try loadOrCreateSecretKey()
    } catch {
      Self.log.error(
        "Push secret unavailable: \(error.localizedDescription, privacy: .public)"
      )
      return
    }

    let label: String?
    #if canImport(UIKit)
    label = UIDevice.current.name
    #else
    label = nil
    #endif

    let hosts: [HostProfileModel]
    do {
      hosts = try hostStore.list()
    } catch {
      Self.log.error(
        "Could not list hosts for push: \(error.localizedDescription, privacy: .public)"
      )
      return
    }

    for host in hosts {
      let client = tokenClient(for: host)
      do {
        try await client.registerPushDevice(
          deviceToken: deviceToken,
          secretKey: secretKey,
          label: label
        )
      } catch {
        Self.log.error(
          "Push register failed for \(host.id, privacy: .public): \(error.localizedDescription, privacy: .public)"
        )
      }
    }
  }

  /// APNs tokens are 32 raw bytes → 64 lowercase hex chars. Server rejects anything else.
  public static func normalizeDeviceToken(_ data: Data) -> String? {
    guard data.count == 32 else { return nil }
    return data.map { String(format: "%02x", $0) }.joined()
  }

  /// One AES-256 key per device (account `tether_push_secret`), shared with every
  /// host and later read by the Notification Service Extension.
  private func loadOrCreateSecretKey() throws -> String {
    if let existing = try readSecretKey(), !existing.isEmpty {
      return existing
    }
    var bytes = [UInt8](repeating: 0, count: Self.keyBytes)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else {
      throw HostClientError.decodeFailed
    }
    let secret = Data(bytes).base64EncodedString()
    try writeSecretKey(secret)
    return secret
  }

  private func readSecretKey() throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.keychainService,
      kSecAttrAccount as String: Self.secretAccount,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else {
      throw HostClientError.decodeFailed
    }
    guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
      return nil
    }
    return value
  }

  private func writeSecretKey(_ value: String) throws {
    let data = Data(value.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.keychainService,
      kSecAttrAccount as String: Self.secretAccount,
    ]
    // AFTER_FIRST_UNLOCK so the future NSE can decrypt on a locked phone.
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      guard update == errSecSuccess else { throw HostClientError.decodeFailed }
      return
    }
    guard status == errSecSuccess else { throw HostClientError.decodeFailed }
  }
}
