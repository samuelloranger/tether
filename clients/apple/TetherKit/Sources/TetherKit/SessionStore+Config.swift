import Foundation
import TetherFFIBindings

/// Config / admin helpers that cannot live in SessionStore.swift (another agent
/// owns that file). Builds a `NativeHostClient` via a fresh `HostStoreAdapter`
/// so we never touch SessionStore's private `hostStore` / `client(for:)`.
extension SessionStore {
  public func makeConfigClient(hostId: String) -> NativeHostClient? {
    client(for: hostId)
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
      // Only mirror the identity into the local host profile when the identity
      // is what was edited. Doing it on every save renamed the user's host —
      // changing a notification trigger relabelled "devbox" to the server's
      // identity, silently discarding a name they chose.
      if !(patch.identity?.isEmpty ?? true) {
        applyServerIdentity(hostId: hostId, identity: next.identity)
      }
      errorMessage = nil
      return next
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func renameHost(hostId: String, name: String) async {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let adapter = HostStoreAdapter()
    do {
      _ = try adapter.update(
        id: hostId,
        changes: FfiHostProfileChanges(
          name: trimmed,
          color: nil,
          host: nil,
          port: nil,
          identityName: nil
        )
      )
      reloadHosts()
    } catch {
      errorMessage = error.localizedDescription
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
    port: String
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
      reloadHosts()
      errorMessage = nil
      await refreshHost(hostId: hostId)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }


  public func requestServerUpdate(hostId: String) async -> Bool {
    guard let client = makeConfigClient(hostId: hostId) else { return false }
    do {
      _ = try await client.updateServer()
      errorMessage = nil
      await refreshHost(hostId: hostId)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func requestServerRestart(hostId: String) async -> Bool {
    guard let client = makeConfigClient(hostId: hostId) else { return false }
    do {
      try await client.restartServer()
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
