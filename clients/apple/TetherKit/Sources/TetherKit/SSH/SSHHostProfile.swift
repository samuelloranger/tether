import Foundation

/// How a host authenticates. The secret itself never lives in the profile:
/// a password is stored in the Keychain under the host id, and `.key` points at
/// a vault key whose private half is likewise Keychain-resident.
public enum SSHAuthMethod: Codable, Equatable, Sendable {
  case password
  case key(keyId: String)
}

/// A saved SSH destination. Pure value type, persisted as JSON — no Rust, no
/// Noise key material. The pinned host key lives in the host-key store, not here.
public struct SSHHostProfile: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var name: String
  public var host: String
  public var port: Int
  public var username: String
  public var auth: SSHAuthMethod
  public var color: String?
  public var createdAt: Date

  public init(
    id: String = UUID().uuidString,
    name: String,
    host: String,
    port: Int = 22,
    username: String,
    auth: SSHAuthMethod,
    color: String? = nil,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.name = name
    self.host = host
    self.port = port
    self.username = username
    self.auth = auth
    self.color = color
    self.createdAt = createdAt
  }
}
