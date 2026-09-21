import Foundation

@MainActor
@Observable
public final class HomeModel {
  public private(set) var profiles: [SSHHostProfile] = []
  public private(set) var keys: [SSHKeyRecord] = []
  public var errorMessage: String?

  let hostKeyStore = UserDefaultsHostKeyStore()

  private let profileStore: SSHProfileStore
  private let vault: SSHKeyVault
  private let secrets: SSHSecretStore

  init(profileStore: SSHProfileStore, vault: SSHKeyVault, secrets: SSHSecretStore) {
    self.profileStore = profileStore
    self.vault = vault
    self.secrets = secrets
    reload()
  }

  public static func live() -> HomeModel {
    let secrets = KeychainSecretStore()
    return HomeModel(
      profileStore: SSHProfileStore(storage: UserDefaultsSSHStore()),
      vault: SSHKeyVault(storage: UserDefaultsSSHStore(), secrets: secrets),
      secrets: secrets
    )
  }

  public func reload() {
    profiles = profileStore.list()
    keys = vault.list()
  }


  public func generateKey(name: String) {
    do { _ = try vault.generateEd25519(name: name); reload() }
    catch { errorMessage = error.localizedDescription }
  }

  public func importKey(name: String, privatePEM: String, publicKey: String, origin: SSHKeyOrigin) {
    _ = vault.importKey(name: name, privatePEM: privatePEM, publicKey: publicKey, origin: origin)
    reload()
  }

  public func deleteKey(id: String) {
    vault.remove(id: id)
    reload()
  }

  public func publicKey(forKeyId id: String) -> String? {
    keys.first { $0.id == id }?.publicKey
  }

  public func keyName(_ id: String) -> String? {
    keys.first { $0.id == id }?.name
  }

  public func machinesUsing(keyId: String) -> [String] {
    profiles.filter { $0.auth == .key(keyId: keyId) }.map(\.name)
  }


  public func addServer(
    name: String, host: String, port: Int, username: String,
    auth: SSHAuthMethod, password: String? = nil
  ) {
    let profile = SSHHostProfile(name: name, host: host, port: port, username: username, auth: auth)
    profileStore.add(profile)
    if case .password = auth, let password { secrets.setSecret(password, forKey: passwordKey(profile.id)) }
    reload()
  }

  public func password(forHostId id: String) -> String? {
    secrets.secret(forKey: passwordKey(id))
  }

  private func passwordKey(_ hostId: String) -> String { "host.password.\(hostId)" }

  public func removeServer(id: String) {
    profileStore.remove(id: id)
    secrets.setSecret(nil, forKey: passwordKey(id))
    reload()
  }

  func connectionConfig(for profile: SSHHostProfile) -> SSHConnectionConfig? {
    let credentials: [SSHCredential]
    switch profile.auth {
    case .password:
      guard let password = password(forHostId: profile.id) else { return nil }
      credentials = [.password(password)]
    case let .key(keyId):
      guard let pem = vault.privatePEM(forKeyId: keyId) else { return nil }
      credentials = [.privateKey(pem: pem, passphrase: nil)]
    }
    return SSHConnectionConfig(
      host: profile.host, port: profile.port, username: profile.username, credentials: credentials
    )
  }


  private let lastHostKey = "tether.ssh.lastHostId"
  public func rememberLastHost(_ id: String?) { UserDefaults.standard.set(id, forKey: lastHostKey) }
  public var lastHostProfile: SSHHostProfile? {
    guard let id = UserDefaults.standard.string(forKey: lastHostKey) else { return nil }
    return profiles.first { $0.id == id }
  }

  public func authLabel(for profile: SSHHostProfile) -> String {
    switch profile.auth {
    case .password: return "password"
    case let .key(keyId): return keyName(keyId) ?? "key"
    }
  }
}

final class InMemorySSHSecrets: SSHSecretStore {
  private var items: [String: String] = [:]
  func setSecret(_ value: String?, forKey key: String) { items[key] = value }
  func secret(forKey key: String) -> String? { items[key] }
}

public extension HomeModel {
  static func preview() -> HomeModel {
    let suite = "tether.home.preview"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let secrets = InMemorySSHSecrets()
    let model = HomeModel(
      profileStore: SSHProfileStore(storage: UserDefaultsSSHStore(defaults: defaults)),
      vault: SSHKeyVault(storage: UserDefaultsSSHStore(defaults: defaults), secrets: secrets),
      secrets: secrets
    )
    model.generateKey(name: "id_ed25519")
    model.importKey(
      name: "work-laptop", privatePEM: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILq/BDv7Gp/1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfz",
      origin: .imported
    )
    if let key = model.keys.first {
      model.addServer(name: "homelab", host: "192.168.50.30", port: 2222, username: "sam", auth: .key(keyId: key.id))
    }
    model.addServer(name: "vps-paris", host: "203.0.113.9", port: 22, username: "root", auth: .password, password: "x")
    return model
  }

  static func liveDemoFromEnv() -> HomeModel {
    let env = ProcessInfo.processInfo.environment
    let suite = "tether.home.livedemo"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let secrets = InMemorySSHSecrets()
    let model = HomeModel(
      profileStore: SSHProfileStore(storage: UserDefaultsSSHStore(defaults: defaults)),
      vault: SSHKeyVault(storage: UserDefaultsSSHStore(defaults: defaults), secrets: secrets),
      secrets: secrets
    )
    if let b64 = env["TETHER_SSH_KEY_B64"], let data = Data(base64Encoded: b64),
       let pem = String(data: data, encoding: .utf8) {
      model.importKey(name: "live", privatePEM: pem, publicKey: env["TETHER_SSH_PUB"] ?? "ssh-ed25519 live", origin: .imported)
    }
    if let keyId = model.keys.first?.id {
      model.addServer(
        name: env["TETHER_SSH_HOST"] ?? "homelab",
        host: env["TETHER_SSH_HOST"] ?? "127.0.0.1",
        port: Int(env["TETHER_SSH_PORT"] ?? "22") ?? 22,
        username: env["TETHER_SSH_USER"] ?? "root",
        auth: .key(keyId: keyId)
      )
    }
    return model
  }
}
