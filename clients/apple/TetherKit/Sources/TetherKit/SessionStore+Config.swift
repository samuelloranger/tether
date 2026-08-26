import Foundation
import TetherFFIBindings

/// Config / admin helpers that cannot live in SessionStore.swift (another agent
/// owns that file). Builds a `NativeHostClient` via a fresh `HostStoreAdapter`
/// so we never touch SessionStore's private `hostStore` / `client(for:)`.
extension SessionStore {
  public func makeConfigClient(hostId: String) -> NativeHostClient? {
    guard let host = hosts.first(where: { $0.id == hostId }) else { return nil }
    let adapter = HostStoreAdapter()
    guard let password = try? adapter.password(for: host.id), !password.isEmpty else {
      return nil
    }
    return NativeHostClient(profile: host, password: password)
  }

  public func loadServerConfig(hostId: String) async -> ServerConfig? {
    guard let client = makeConfigClient(hostId: hostId) else { return nil }
    do {
      return try await client.fetchServerConfig()
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func loadServerVersion(hostId: String) async -> String? {
    guard let client = makeConfigClient(hostId: hostId) else { return nil }
    do {
      return try await client.fetchServerVersion()
    } catch {
      return nil
    }
  }

  /// PATCH `/api/config`. On success, mirrors RN `onIdentitySaved` into the local
  /// host profile (name + colour + identityName).
  public func saveServerConfig(
    hostId: String,
    config: ServerConfig,
    draft: ServerSettingsDraft
  ) async -> ServerConfig? {
    let errors = validateServerSettingsDraft(draft)
    guard errors.isEmpty else {
      errorMessage = errors.values.first
      return nil
    }
    let patch = patchForDraft(config: config, draft: draft)
    guard !patch.isEmpty else { return config }
    guard let client = makeConfigClient(hostId: hostId) else { return nil }
    do {
      let next = try await client.patchServerConfig(patch)
      applyServerIdentity(hostId: hostId, identity: next.identity)
      errorMessage = nil
      return next
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func applyServerIdentity(hostId: String, identity: ServerIdentityConfig) {
    let adapter = HostStoreAdapter()
    do {
      _ = try adapter.update(
        id: hostId,
        changes: FfiHostProfileChanges(
          name: identity.name,
          color: identity.color,
          host: nil,
          port: nil,
          identityName: identity.name
        )
      )
      reloadHosts()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func saveHostConnection(
    hostId: String,
    host: String,
    port: String,
    replacementPassword: String?
  ) async -> Bool {
    let adapter = HostStoreAdapter()
    do {
      _ = try adapter.update(
        id: hostId,
        changes: FfiHostProfileChanges(
          name: nil,
          color: nil,
          host: host,
          port: port,
          identityName: nil
        )
      )
      if let replacementPassword, !replacementPassword.isEmpty {
        try adapter.setPassword(replacementPassword, for: hostId)
      }
      reloadHosts()
      errorMessage = nil
      await refreshHost(hostId: hostId)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func changeServerPassword(
    hostId: String,
    current: String,
    next: String
  ) async -> Bool {
    guard let client = makeConfigClient(hostId: hostId) else { return false }
    do {
      try await client.changeServerPassword(current: current, next: next)
      let adapter = HostStoreAdapter()
      try adapter.setPassword(next, for: hostId)
      errorMessage = nil
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func requestServerUpdate(hostId: String, current: String) async -> Bool {
    guard let client = makeConfigClient(hostId: hostId) else { return false }
    do {
      _ = try await client.updateServer(current: current)
      errorMessage = nil
      await refreshHost(hostId: hostId)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func requestServerRestart(hostId: String, current: String) async -> Bool {
    guard let client = makeConfigClient(hostId: hostId) else { return false }
    do {
      try await client.restartServer(current: current)
      errorMessage = nil
      await refreshHost(hostId: hostId)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func sendServerTestNotification(hostId: String) async -> Bool {
    guard let client = makeConfigClient(hostId: hostId) else { return false }
    do {
      try await client.sendTestNotification()
      errorMessage = nil
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }
}
