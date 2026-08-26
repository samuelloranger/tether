import Foundation
import TetherFFIBindings

/// Keychain-backed secret store — keys match RN: `tether_password_<hostId>`.
public final class KeychainSecretStore: SecretStore {
  private let service = "dev.tether.app"

  public init() {}

  public func get(hostId: String) throws -> String? {
    try read(account: account(for: hostId))
  }

  public func set(hostId: String, password: String) throws {
    try write(account: account(for: hostId), value: password)
  }

  public func clear(hostId: String) throws {
    try delete(account: account(for: hostId))
  }

  public func getLegacy() throws -> String? {
    try read(account: "tether_password")
  }

  public func clearLegacy() throws {
    try delete(account: "tether_password")
  }

  private func account(for hostId: String) -> String {
    "tether_password_\(hostId)"
  }

  private func read(account: String) throws -> String? {
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
      throw FfiHostStoreError.Secret(message: "Keychain read failed (\(status))")
    }
    guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
      throw FfiHostStoreError.Secret(message: "Keychain payload is not UTF-8")
    }
    return value
  }

  private func write(account: String, value: String) throws {
    let data = Data(value.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    if status == errSecDuplicateItem {
      let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      guard updateStatus == errSecSuccess else {
        throw FfiHostStoreError.Secret(message: "Keychain update failed (\(updateStatus))")
      }
      return
    }
    guard status == errSecSuccess else {
      throw FfiHostStoreError.Secret(message: "Keychain write failed (\(status))")
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
    throw FfiHostStoreError.Secret(message: "Keychain delete failed (\(status))")
  }
}
