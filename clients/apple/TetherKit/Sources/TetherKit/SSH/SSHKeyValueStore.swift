import Foundation

/// Minimal key-value persistence seam so the SSH stores can be unit-tested with
/// an in-memory double instead of real UserDefaults.
protocol SSHKeyValueStore: AnyObject {
  func data(forKey key: String) -> Data?
  func set(_ data: Data?, forKey key: String)
}

/// UserDefaults-backed implementation for the app. Non-secret data only —
/// profiles, key metadata, host-key pins. Private key material goes to the
/// Keychain, never here.
final class UserDefaultsSSHStore: SSHKeyValueStore {
  private let defaults: UserDefaults
  init(defaults: UserDefaults = .standard) { self.defaults = defaults }
  func data(forKey key: String) -> Data? { defaults.data(forKey: key) }
  func set(_ data: Data?, forKey key: String) {
    if let data { defaults.set(data, forKey: key) } else { defaults.removeObject(forKey: key) }
  }
}
