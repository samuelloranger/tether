import Foundation
import XCTest
@testable import TetherKit

private final class MemoryKVStore: SSHKeyValueStore {
  var items: [String: Data] = [:]
  func data(forKey key: String) -> Data? { items[key] }
  func set(_ data: Data?, forKey key: String) {
    if let data { items[key] = data } else { items[key] = nil }
  }
}

final class SSHProfileStoreTests: XCTestCase {
  private func profile(_ id: String, name: String = "Dev") -> SSHHostProfile {
    SSHHostProfile(id: id, name: name, host: "h", port: 2222, username: "u", auth: .key(keyId: "k1"))
  }

  func test_starts_empty() {
    let store = SSHProfileStore(storage: MemoryKVStore())
    XCTAssertEqual(store.list(), [])
  }

  func test_add_then_list_round_trips_through_storage() {
    let kv = MemoryKVStore()
    let p = profile("a")
    SSHProfileStore(storage: kv).add(p)
    // A fresh store over the same storage sees the persisted profile.
    XCTAssertEqual(SSHProfileStore(storage: kv).list(), [p])
  }

  func test_add_preserves_insertion_order() {
    let store = SSHProfileStore(storage: MemoryKVStore())
    store.add(profile("a"))
    store.add(profile("b"))
    XCTAssertEqual(store.list().map(\.id), ["a", "b"])
  }

  func test_add_with_existing_id_updates_in_place() {
    let store = SSHProfileStore(storage: MemoryKVStore())
    store.add(profile("a", name: "Old"))
    store.add(profile("a", name: "New"))
    XCTAssertEqual(store.list().count, 1)
    XCTAssertEqual(store.list().first?.name, "New")
  }

  func test_remove_deletes_only_the_named_profile() {
    let store = SSHProfileStore(storage: MemoryKVStore())
    store.add(profile("a"))
    store.add(profile("b"))
    store.remove(id: "a")
    XCTAssertEqual(store.list().map(\.id), ["b"])
  }
}
