import Foundation
import Security

/// Keychain-backed secret store for SSH private-key PEM and host passwords.
/// Items are device-only (no iCloud sync) and readable after first unlock, which
/// a foreground-redial connect always satisfies.
final class KeychainSecretStore: SSHSecretStore {
  private let service: String

  init(service: String = "tether.ssh.secrets") {
    self.service = service
  }

  func setSecret(_ value: String?, forKey key: String) {
    guard let value, let data = value.data(using: .utf8) else {
      SecItemDelete(baseQuery(key) as CFDictionary)
      return
    }
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(baseQuery(key) as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      var insert = baseQuery(key)
      insert.merge(attributes) { _, new in new }
      SecItemAdd(insert as CFDictionary, nil)
    }
  }

  func secret(forKey key: String) -> String? {
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }
}
