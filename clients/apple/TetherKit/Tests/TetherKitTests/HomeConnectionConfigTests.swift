import Foundation
import XCTest
@testable import TetherKit

@MainActor
final class HomeConnectionConfigTests: XCTestCase {
  private final class KV: SSHKeyValueStore {
    var items: [String: Data] = [:]
    func data(forKey key: String) -> Data? { items[key] }
    func set(_ data: Data?, forKey key: String) { items[key] = data }
  }
  private final class Secrets: SSHSecretStore {
    var s: [String: String] = [:]
    func setSecret(_ value: String?, forKey key: String) { s[key] = value }
    func secret(forKey key: String) -> String? { s[key] }
  }

  private func model() -> HomeModel {
    let kv = KV(); let sec = Secrets()
    return HomeModel(profileStore: SSHProfileStore(storage: kv), vault: SSHKeyVault(storage: kv, secrets: sec), secrets: sec)
  }

  func test_key_auth_resolves_the_private_pem_from_the_vault() throws {
    let m = model()
    m.generateKey(name: "k")
    let keyId = try XCTUnwrap(m.keys.first?.id)
    m.addServer(name: "h", host: "host", port: 2222, username: "u", auth: .key(keyId: keyId))
    let profile = m.profiles[0]
    let config = try XCTUnwrap(m.connectionConfig(for: profile))
    XCTAssertEqual(config.host, "host")
    XCTAssertEqual(config.port, 2222)
    XCTAssertEqual(config.username, "u")
    guard case let .privateKey(pem, _) = config.credentials.first else { return XCTFail("expected key credential") }
    XCTAssertTrue(pem.contains("BEGIN PRIVATE KEY"))
  }

  func test_password_auth_resolves_the_stored_password() throws {
    let m = model()
    m.addServer(name: "h", host: "host", port: 22, username: "u", auth: .password, password: "hunter2")
    let config = try XCTUnwrap(m.connectionConfig(for: m.profiles[0]))
    XCTAssertEqual(config.credentials, [.password("hunter2")])
  }

  func test_returns_nil_when_the_referenced_key_is_missing() {
    let m = model()
    m.addServer(name: "h", host: "host", port: 22, username: "u", auth: .key(keyId: "ghost"))
    XCTAssertNil(m.connectionConfig(for: m.profiles[0]))
  }

  func test_returns_nil_when_no_password_was_stored() {
    let m = model()
    m.addServer(name: "h", host: "host", port: 22, username: "u", auth: .password, password: nil)
    XCTAssertNil(m.connectionConfig(for: m.profiles[0]))
  }
}
