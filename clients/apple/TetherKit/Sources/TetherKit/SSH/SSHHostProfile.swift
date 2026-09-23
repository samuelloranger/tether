import Foundation

public enum SSHAuthMethod: Codable, Equatable, Sendable {
  case password
  case key(keyId: String)
}

public struct SSHHostProfile: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var name: String
  public var host: String
  public var port: Int
  public var username: String
  public var auth: SSHAuthMethod

  public init(
    id: String = UUID().uuidString,
    name: String,
    host: String,
    port: Int = 22,
    username: String,
    auth: SSHAuthMethod
  ) {
    self.id = id
    self.name = name
    self.host = host
    self.port = port
    self.username = username
    self.auth = auth
  }
}
