import Foundation
@testable import TetherKit

/// Shared in-memory doubles for the SSH store/vault tests. Pairs with the
/// module's `InMemorySSHSecrets` for the secret side.
final class InMemoryKV: SSHKeyValueStore {
  var items: [String: Data] = [:]
  func data(forKey key: String) -> Data? { items[key] }
  func set(_ data: Data?, forKey key: String) { items[key] = data }
}
