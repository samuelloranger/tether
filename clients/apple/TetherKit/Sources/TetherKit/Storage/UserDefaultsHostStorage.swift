import Foundation
import TetherFFIBindings

/// Host profile JSON persistence — mirrors AsyncStorage keys from the RN client.
public final class UserDefaultsHostStorage: HostStorage {
  private let defaults: UserDefaults
  private let prefix = "tether_host_store_"

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func getItem(key: String) throws -> String? {
    defaults.string(forKey: prefixed(key))
  }

  public func setItem(key: String, value: String) throws {
    defaults.set(value, forKey: prefixed(key))
  }

  public func removeItem(key: String) throws {
    defaults.removeObject(forKey: prefixed(key))
  }

  private func prefixed(_ key: String) -> String {
    prefix + key
  }
}
