import CryptoKit
import Foundation

public enum SSHKeyOrigin: String, Codable, Equatable, Sendable {
  case generated, imported, pasted
}

/// Public metadata for a vault key. The private half is never here — it lives in
/// the secret store (Keychain), addressed by `id`.
public struct SSHKeyRecord: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var name: String
  public var algorithm: String
  public var publicKey: String
  public var fingerprint: String
  public var origin: SSHKeyOrigin
  public var createdAt: Date
}

/// Secret persistence seam. The app backs it with the Keychain; tests use an
/// in-memory double.
protocol SSHSecretStore: AnyObject {
  func setSecret(_ value: String?, forKey key: String)
  func secret(forKey key: String) -> String?
}

/// The key vault: public metadata as JSON, private PEM in the secret store.
/// Shared across every host, so a key can back more than one profile.
final class SSHKeyVault {
  private let storage: SSHKeyValueStore
  private let secrets: SSHSecretStore
  private let key = "tether.ssh.keys"

  init(storage: SSHKeyValueStore, secrets: SSHSecretStore) {
    self.storage = storage
    self.secrets = secrets
  }

  func list() -> [SSHKeyRecord] {
    guard let data = storage.data(forKey: key),
          let records = try? JSONDecoder().decode([SSHKeyRecord].self, from: data)
    else { return [] }
    return records
  }

  @discardableResult
  func generateEd25519(name: String) throws -> SSHKeyRecord {
    let privateKey = Curve25519.Signing.PrivateKey()
    let seed = privateKey.rawRepresentation
    let pub = privateKey.publicKey.rawRepresentation
    let publicKey = SSHKeyEncoding.openSSHPublicKey(rawEd25519: pub, comment: name)
    let pem = SSHKeyEncoding.pkcs8PEM(ed25519Seed: seed)
    return store(name: name, publicKey: publicKey, privatePEM: pem, origin: .generated)
  }

  @discardableResult
  func importKey(name: String, privatePEM: String, publicKey: String, origin: SSHKeyOrigin) -> SSHKeyRecord {
    store(name: name, publicKey: publicKey, privatePEM: privatePEM, origin: origin)
  }

  func privatePEM(forKeyId id: String) -> String? {
    secrets.secret(forKey: id)
  }

  func remove(id: String) {
    persist(list().filter { $0.id != id })
    secrets.setSecret(nil, forKey: id)
  }

  private func store(name: String, publicKey: String, privatePEM: String, origin: SSHKeyOrigin) -> SSHKeyRecord {
    let record = SSHKeyRecord(
      id: UUID().uuidString,
      name: name,
      algorithm: "ssh-ed25519",
      publicKey: publicKey,
      fingerprint: SSHKeyEncoding.fingerprint(openSSHPublicKey: publicKey),
      origin: origin,
      createdAt: Date()
    )
    secrets.setSecret(privatePEM, forKey: record.id)
    persist(list() + [record])
    return record
  }

  private func persist(_ records: [SSHKeyRecord]) {
    storage.set(try? JSONEncoder().encode(records), forKey: key)
  }
}
