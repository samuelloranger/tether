import Foundation

/// Per-host Noise key material: the device's own static private key and the
/// pinned server static public key learned at pairing time. Kept behind a
/// protocol so unit tests can drive a fake instead of the real Keychain.
///
/// Keys are raw curve bytes (`Data`), never UTF-8 strings. They live in their
/// own Keychain item namespace so they never collide with other host records.
public protocol NoiseKeyStore {
  func loadDevicePrivateKey(hostId: String) throws -> Data?
  func saveDevicePrivateKey(_ key: Data, hostId: String) throws
  func loadServerPublicKey(hostId: String) throws -> Data?
  func saveServerPublicKey(_ key: Data, hostId: String) throws
  /// Drop both the device key and the pinned server key for a host (unpair).
  func clear(hostId: String) throws
}

public enum NoiseKeychainError: Error, LocalizedError {
  case status(OSStatus, String)

  public var errorDescription: String? {
    switch self {
    case let .status(code, op):
      "Keychain \(op) failed (\(code))"
    }
  }
}

/// Keychain-backed `NoiseKeyStore`. Accounts:
///   `tether.noise.device.<hostId>` — device static private key
///   `tether.noise.server.<hostId>` — pinned server static public key
public final class KeychainNoiseKeyStore: NoiseKeyStore {
  private let service = "dev.tether.app"

  public init() {}

  public func loadDevicePrivateKey(hostId: String) throws -> Data? {
    try read(account: deviceAccount(hostId))
  }

  public func saveDevicePrivateKey(_ key: Data, hostId: String) throws {
    try write(account: deviceAccount(hostId), value: key)
  }

  public func loadServerPublicKey(hostId: String) throws -> Data? {
    try read(account: serverAccount(hostId))
  }

  public func saveServerPublicKey(_ key: Data, hostId: String) throws {
    try write(account: serverAccount(hostId), value: key)
  }

  public func clear(hostId: String) throws {
    try delete(account: deviceAccount(hostId))
    try delete(account: serverAccount(hostId))
  }

  private func deviceAccount(_ hostId: String) -> String { "tether.noise.device.\(hostId)" }
  private func serverAccount(_ hostId: String) -> String { "tether.noise.server.\(hostId)" }

  private func read(account: String) throws -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else {
      throw NoiseKeychainError.status(status, "read")
    }
    guard let data = item as? Data else {
      throw NoiseKeychainError.status(errSecDecode, "read")
    }
    return data
  }

  private func write(account: String, value: Data) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: value,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      guard updateStatus == errSecSuccess else {
        throw NoiseKeychainError.status(updateStatus, "update")
      }
      return
    }
    guard status == errSecSuccess else {
      throw NoiseKeychainError.status(status, "write")
    }
  }

  private func delete(account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound { return }
    throw NoiseKeychainError.status(status, "delete")
  }
}
