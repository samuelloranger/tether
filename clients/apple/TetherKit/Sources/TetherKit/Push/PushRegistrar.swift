import Foundation
import OSLog
import Security

#if canImport(UIKit)
import UIKit
import UserNotifications
#endif

/// Requests notification permission, obtains the APNs device token, and holds
/// the device push identity the SSH path hands to the host's `tether-notify`.
///
/// Failures are logged and swallowed — push must never block or throw into UI.
@MainActor
public final class PushRegistrar {
  private enum PushError: Error { case secretUnavailable }

  private static let log = Logger(subsystem: "dev.tether.app", category: "push")
  private static let tokenDefaultsKey = "tether_push_device_token"
  private static let secretAccount = "tether_push_secret"
  private static let keychainService = "dev.tether.app"
  private static let keyBytes = 32

  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  /// Persisted APNs token (lowercase 64-hex), if any.
  public var storedDeviceToken: String? {
    defaults.string(forKey: Self.tokenDefaultsKey)
  }

  /// The device's push identity for the v5 SSH path: the app hands this to the
  /// host's `tether-notify register` over SSH. `nil` until APNs has issued a token.
  public struct PushIdentity: Sendable {
    public let token: String
    public let secretKey: String
    public let label: String
  }

  public func pushIdentity() -> PushIdentity? {
    guard let token = storedDeviceToken, let secret = try? loadOrCreateSecretKey() else { return nil }
    #if canImport(UIKit)
    let label = UIDevice.current.name
    #else
    let label = "iOS"
    #endif
    return PushIdentity(token: token, secretKey: secret, label: label)
  }

  /// Ask for alert/sound/badge, then `registerForRemoteNotifications`.
  public func start() {
    #if canImport(UIKit)
    #if DEBUG
    // A preseeded UI-test launch skips the system notification prompt: it steals
    // first responder from the terminal and blocks the keyboard a headless-sim
    // repro needs. No-op only under that env; normal dev/Release is untouched.
    if ProcessInfo.processInfo.environment["TETHER_UITEST_PRESEED"] != nil { return }
    #endif
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
  }

  public func handleRegistrationFailure(_ error: Error) {
    Self.log.error(
      "APNs registration failed: \(error.localizedDescription, privacy: .public)"
    )
  }

  /// APNs tokens are 32 raw bytes → 64 lowercase hex chars.
  public static func normalizeDeviceToken(_ data: Data) -> String? {
    guard data.count == 32 else { return nil }
    return data.map { String(format: "%02x", $0) }.joined()
  }

  /// One AES-256 key per device (account `tether_push_secret`), shared with the
  /// host and later read by the Notification Service Extension.
  private func loadOrCreateSecretKey() throws -> String {
    if let existing = try readSecretKey(), !existing.isEmpty {
      return existing
    }
    var bytes = [UInt8](repeating: 0, count: Self.keyBytes)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else { throw PushError.secretUnavailable }
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
    guard status == errSecSuccess else { throw PushError.secretUnavailable }
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
    // AFTER_FIRST_UNLOCK so the NSE can decrypt on a locked phone.
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      guard update == errSecSuccess else { throw PushError.secretUnavailable }
      return
    }
    guard status == errSecSuccess else { throw PushError.secretUnavailable }
  }
}
