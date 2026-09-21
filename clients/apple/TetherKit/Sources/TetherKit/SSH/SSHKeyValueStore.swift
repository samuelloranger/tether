import Foundation

protocol SSHKeyValueStore: AnyObject {
  func data(forKey key: String) -> Data?
  func set(_ data: Data?, forKey key: String)
}

final class UserDefaultsSSHStore: SSHKeyValueStore {
  private let defaults: UserDefaults
  init(defaults: UserDefaults = .standard) { self.defaults = defaults }
  func data(forKey key: String) -> Data? { defaults.data(forKey: key) }
  func set(_ data: Data?, forKey key: String) {
    if let data { defaults.set(data, forKey: key) } else { defaults.removeObject(forKey: key) }
  }
}
