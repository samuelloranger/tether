import Foundation
import TetherFFIBindings

public struct HostProfileModel: Identifiable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var color: String
  public var host: String
  public var port: String
  public var identityName: String
  public var order: UInt32

  public init(_ ffi: FfiHostProfile) {
    id = ffi.id
    name = ffi.name
    color = ffi.color
    host = ffi.host
    port = ffi.port
    identityName = ffi.identityName
    order = ffi.order
  }

  public var baseHTTPURL: URL? {
    URL(string: "\(HostScheme.scheme(forHost: id, port: port))://\(host):\(port)")
  }

  public var baseWSURL: URL? {
    let ws = HostScheme.isSecure(forHost: id, port: port) ? "wss" : "ws"
    return URL(string: "\(ws)://\(host):\(port)")
  }
}

public final class HostStoreAdapter {
  private let handle: HostStoreHandle
  private let secrets: SecretStore

  public init(
    storage: HostStorage = UserDefaultsHostStorage(),
    secrets: SecretStore = KeychainSecretStore()
  ) {
    handle = HostStoreHandle(storage: storage, secrets: secrets)
    self.secrets = secrets
  }

  public func list() throws -> [HostProfileModel] {
    try handle.list().map(HostProfileModel.init)
  }

  public func create(
    name: String,
    color: String,
    host: String,
    port: String,
    identityName: String
  ) throws -> HostProfileModel {
    let input = FfiNewHostProfile(
      name: name,
      color: color,
      host: host,
      port: port,
      identityName: identityName
    )
    return HostProfileModel(try handle.create(input: input))
  }

  public func update(id: String, changes: FfiHostProfileChanges) throws -> HostProfileModel {
    HostProfileModel(try handle.update(id: id, changes: changes))
  }

  public func remove(id: String) throws {
    try handle.remove(id: id)
  }

  public func reorder(ids: [String]) throws -> [HostProfileModel] {
    try handle.reorder(ids: ids).map(HostProfileModel.init)
  }

  public func password(for hostId: String) throws -> String? {
    try secrets.get(hostId: hostId)
  }

  public func setPassword(_ password: String, for hostId: String) throws {
    try secrets.set(hostId: hostId, password: password)
  }
}
