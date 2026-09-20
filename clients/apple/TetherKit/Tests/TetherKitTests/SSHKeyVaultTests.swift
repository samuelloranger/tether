import Foundation
import XCTest
@testable import TetherKit

private final class MemoryKV: SSHKeyValueStore {
  var items: [String: Data] = [:]
  func data(forKey key: String) -> Data? { items[key] }
  func set(_ data: Data?, forKey key: String) { items[key] = data }
}

private final class MemorySecrets: SSHSecretStore {
  var secrets: [String: String] = [:]
  func setSecret(_ value: String?, forKey key: String) { secrets[key] = value }
  func secret(forKey key: String) -> String? { secrets[key] }
}

final class SSHKeyVaultTests: XCTestCase {
  private func vault() -> (SSHKeyVault, MemoryKV, MemorySecrets) {
    let kv = MemoryKV(); let sec = MemorySecrets()
    return (SSHKeyVault(storage: kv, secrets: sec), kv, sec)
  }

  func test_generate_persists_a_record_and_stashes_the_private_pem_separately() throws {
    let (v, _, sec) = vault()
    let record = try v.generateEd25519(name: "phone")
    XCTAssertEqual(v.list().map(\.id), [record.id])
    XCTAssertEqual(record.algorithm, "ssh-ed25519")
    XCTAssertEqual(record.origin, .generated)
    XCTAssertTrue(record.publicKey.hasPrefix("ssh-ed25519 "))
    // Fingerprint is self-consistent with the stored public key.
    XCTAssertEqual(record.fingerprint, SSHKeyEncoding.fingerprint(openSSHPublicKey: record.publicKey))
    // Private half lives only in the secret store, never in the record/metadata.
    XCTAssertNotNil(sec.secret(forKey: record.id))
    XCTAssertTrue(v.privatePEM(forKeyId: record.id)?.contains("BEGIN PRIVATE KEY") ?? false)
  }

  func test_generated_keys_are_distinct() throws {
    let (v, _, _) = vault()
    let a = try v.generateEd25519(name: "a")
    let b = try v.generateEd25519(name: "b")
    XCTAssertNotEqual(a.fingerprint, b.fingerprint)
  }

  func test_import_stores_supplied_pem_and_public_key() {
    let (v, _, sec) = vault()
    let pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILq/BDv7Gp/1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfz"
    let record = v.importKey(name: "laptop", privatePEM: "PEMDATA", publicKey: pub, origin: .pasted)
    XCTAssertEqual(record.origin, .pasted)
    XCTAssertEqual(record.publicKey, pub)
    XCTAssertEqual(record.fingerprint, "SHA256:qQubUJmzqluQ5lmjKUy3awN04Qv0ts1nr4pZWS2gI8o")
    XCTAssertEqual(sec.secret(forKey: record.id), "PEMDATA")
  }

  func test_remove_deletes_both_the_record_and_the_secret() throws {
    let (v, _, sec) = vault()
    let record = try v.generateEd25519(name: "x")
    v.remove(id: record.id)
    XCTAssertEqual(v.list(), [])
    XCTAssertNil(sec.secret(forKey: record.id))
  }
}
