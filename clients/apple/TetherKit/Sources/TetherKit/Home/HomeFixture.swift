#if DEBUG
import Foundation

public extension HomeModel {
  /// Neutral machines for README shots: `TETHER_HOME_PREVIEW=neutral`.
  static func neutralPreview() -> HomeModel {
    let suite = "tether.home.neutral"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let secrets = InMemorySSHSecrets()
    let model = HomeModel(
      profileStore: SSHProfileStore(storage: UserDefaultsSSHStore(defaults: defaults)),
      vault: SSHKeyVault(storage: UserDefaultsSSHStore(defaults: defaults), secrets: secrets),
      secrets: secrets
    )
    model.generateKey(name: "id_ed25519")
    if let key = model.keys.first {
      model.addServer(name: "devbox", host: "203.0.113.10", port: 22, username: "dev", auth: .key(keyId: key.id))
      model.addServer(name: "vps-example", host: "203.0.113.20", port: 22, username: "dev", auth: .key(keyId: key.id))
    }
    model.addServer(name: "build-server", host: "203.0.113.30", port: 22, username: "ci", auth: .password, password: "x")
    return model
  }
}
#endif
