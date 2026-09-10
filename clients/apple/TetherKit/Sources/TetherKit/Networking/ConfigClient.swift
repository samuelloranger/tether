import Foundation

// MARK: - Response models (shapes from apps/server config.ts + routes/config.ts)

public struct ServerPushConfig: Codable, Equatable, Sendable {
  public var enabled: Bool

  public init(enabled: Bool) {
    self.enabled = enabled
  }
}

public struct ServerTriggersConfig: Codable, Equatable, Sendable {
  public var waiting: Bool
  /// Absent on a server older than v2.9 — decode as off rather than failing the
  /// whole config fetch over one missing flag.
  public var done: Bool
  public var oscNotify: Bool
  public var exit: Bool
  public var longJob: Bool

  public init(waiting: Bool, done: Bool = false, oscNotify: Bool, exit: Bool, longJob: Bool) {
    self.waiting = waiting
    self.done = done
    self.oscNotify = oscNotify
    self.exit = exit
    self.longJob = longJob
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    waiting = try c.decode(Bool.self, forKey: .waiting)
    done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
    oscNotify = try c.decode(Bool.self, forKey: .oscNotify)
    exit = try c.decode(Bool.self, forKey: .exit)
    longJob = try c.decode(Bool.self, forKey: .longJob)
  }
}

public struct ServerIdentityConfig: Codable, Equatable, Sendable {
  public var name: String
  public var color: String

  public init(name: String, color: String) {
    self.name = name
    self.color = color
  }
}

public struct ServerSessionConfig: Codable, Equatable, Sendable {
  public var defaultShell: String
  public var defaultCwd: String
  public var scrollbackRows: Int
  public var silenceMs: Int

  public init(defaultShell: String, defaultCwd: String, scrollbackRows: Int, silenceMs: Int) {
    self.defaultShell = defaultShell
    self.defaultCwd = defaultCwd
    self.scrollbackRows = scrollbackRows
    self.silenceMs = silenceMs
  }
}

/// Read-only transport report from GET `/api/config` (`tlsConfig.ts` TlsReport).
public struct ServerTlsReport: Codable, Equatable, Sendable {
  public var enabled: Bool
  public var plaintext: Bool
  public var port: Int?
  public var fingerprint: String?

  public init(enabled: Bool, plaintext: Bool, port: Int? = nil, fingerprint: String? = nil) {
    self.enabled = enabled
    self.plaintext = plaintext
    self.port = port
    self.fingerprint = fingerprint
  }
}

/// Full GET `/api/config` body — editable keys plus derived `pushDevices` / `tls`.
public struct ServerConfig: Codable, Equatable, Sendable {
  public var push: ServerPushConfig
  public var pushDevices: Int
  public var triggers: ServerTriggersConfig
  public var longJobSeconds: Int
  public var identity: ServerIdentityConfig
  public var session: ServerSessionConfig
  public var tls: ServerTlsReport?

  public init(
    push: ServerPushConfig,
    pushDevices: Int,
    triggers: ServerTriggersConfig,
    longJobSeconds: Int,
    identity: ServerIdentityConfig,
    session: ServerSessionConfig,
    tls: ServerTlsReport? = nil
  ) {
    self.push = push
    self.pushDevices = pushDevices
    self.triggers = triggers
    self.longJobSeconds = longJobSeconds
    self.identity = identity
    self.session = session
    self.tls = tls
  }
}

public struct ServerConfigPatch: Equatable, Sendable {
  public var push: ServerPushConfig?
  public var triggers: PartialTriggers?
  public var longJobSeconds: Int?
  public var identity: PartialIdentity?
  public var session: PartialSession?

  public init(
    push: ServerPushConfig? = nil,
    triggers: PartialTriggers? = nil,
    longJobSeconds: Int? = nil,
    identity: PartialIdentity? = nil,
    session: PartialSession? = nil
  ) {
    self.push = push
    self.triggers = triggers
    self.longJobSeconds = longJobSeconds
    self.identity = identity
    self.session = session
  }

  public struct PartialTriggers: Equatable, Sendable {
    public var waiting: Bool?
    public var done: Bool?
    public var oscNotify: Bool?
    public var exit: Bool?
    public var longJob: Bool?

    public init(
      waiting: Bool? = nil,
      done: Bool? = nil,
      oscNotify: Bool? = nil,
      exit: Bool? = nil,
      longJob: Bool? = nil
    ) {
      self.waiting = waiting
      self.done = done
      self.oscNotify = oscNotify
      self.exit = exit
      self.longJob = longJob
    }

    public var isEmpty: Bool {
      waiting == nil && done == nil && oscNotify == nil && exit == nil && longJob == nil
    }
  }

  public struct PartialIdentity: Equatable, Sendable {
    public var name: String?
    public var color: String?

    public init(name: String? = nil, color: String? = nil) {
      self.name = name
      self.color = color
    }

    public var isEmpty: Bool { name == nil && color == nil }
  }

  public struct PartialSession: Equatable, Sendable {
    public var defaultShell: String?
    public var defaultCwd: String?
    public var scrollbackRows: Int?
    public var silenceMs: Int?

    public init(
      defaultShell: String? = nil,
      defaultCwd: String? = nil,
      scrollbackRows: Int? = nil,
      silenceMs: Int? = nil
    ) {
      self.defaultShell = defaultShell
      self.defaultCwd = defaultCwd
      self.scrollbackRows = scrollbackRows
      self.silenceMs = silenceMs
    }

    public var isEmpty: Bool {
      defaultShell == nil && defaultCwd == nil && scrollbackRows == nil && silenceMs == nil
    }
  }

  public var isEmpty: Bool {
    push == nil
      && (triggers?.isEmpty ?? true)
      && longJobSeconds == nil
      && (identity?.isEmpty ?? true)
      && (session?.isEmpty ?? true)
  }

  /// JSON object for PATCH `/api/config` (only present keys).
  public func jsonObject() -> [String: Any] {
    var root: [String: Any] = [:]
    if let push {
      root["push"] = ["enabled": push.enabled]
    }
    if let triggers, !triggers.isEmpty {
      var obj: [String: Any] = [:]
      if let waiting = triggers.waiting { obj["waiting"] = waiting }
      if let done = triggers.done { obj["done"] = done }
      if let oscNotify = triggers.oscNotify { obj["oscNotify"] = oscNotify }
      if let exit = triggers.exit { obj["exit"] = exit }
      if let longJob = triggers.longJob { obj["longJob"] = longJob }
      root["triggers"] = obj
    }
    if let longJobSeconds {
      root["longJobSeconds"] = longJobSeconds
    }
    if let identity, !identity.isEmpty {
      var obj: [String: Any] = [:]
      if let name = identity.name { obj["name"] = name }
      if let color = identity.color { obj["color"] = color }
      root["identity"] = obj
    }
    if let session, !session.isEmpty {
      var obj: [String: Any] = [:]
      if let defaultShell = session.defaultShell { obj["defaultShell"] = defaultShell }
      if let defaultCwd = session.defaultCwd { obj["defaultCwd"] = defaultCwd }
      if let scrollbackRows = session.scrollbackRows { obj["scrollbackRows"] = scrollbackRows }
      if let silenceMs = session.silenceMs { obj["silenceMs"] = silenceMs }
      root["session"] = obj
    }
    return root
  }
}

/// Editable draft — numeric fields stay strings (RN `ServerSettingsDraft` semantics).
public struct ServerSettingsDraft: Equatable, Sendable {
  public var push: ServerPushConfig
  public var pushDevices: Int
  public var triggers: ServerTriggersConfig
  public var longJobSeconds: String
  public var identity: ServerIdentityConfig
  public var sessionShell: String
  public var sessionCwd: String
  public var scrollbackRows: String
  /// Silence threshold in **seconds** (API stores ms).
  public var silenceSeconds: String
  public var tls: ServerTlsReport?

  public init(from config: ServerConfig) {
    push = config.push
    pushDevices = config.pushDevices
    triggers = config.triggers
    longJobSeconds = String(config.longJobSeconds)
    identity = config.identity
    sessionShell = config.session.defaultShell
    sessionCwd = config.session.defaultCwd
    scrollbackRows = String(config.session.scrollbackRows)
    let silence = Double(config.session.silenceMs) / 1000.0
    if silence.rounded() == silence {
      silenceSeconds = String(Int(silence))
    } else {
      silenceSeconds = String(silence)
    }
    tls = config.tls
  }
}

public enum ServerSettingsFieldError: String, Sendable {
  case identityName
  case identityColor
  case longJobSeconds
  case defaultShell
  case defaultCwd
  case scrollbackRows
  case silenceMs
}

public func createServerSettingsDraft(_ config: ServerConfig) -> ServerSettingsDraft {
  ServerSettingsDraft(from: config)
}

public func patchForDraft(config: ServerConfig, draft: ServerSettingsDraft) -> ServerConfigPatch {
  var patch = ServerConfigPatch()
  if config.push.enabled != draft.push.enabled {
    patch.push = ServerPushConfig(enabled: draft.push.enabled)
  }
  var triggers = ServerConfigPatch.PartialTriggers()
  if config.triggers.waiting != draft.triggers.waiting { triggers.waiting = draft.triggers.waiting }
  if config.triggers.done != draft.triggers.done { triggers.done = draft.triggers.done }
  if config.triggers.oscNotify != draft.triggers.oscNotify {
    triggers.oscNotify = draft.triggers.oscNotify
  }
  if config.triggers.exit != draft.triggers.exit { triggers.exit = draft.triggers.exit }
  if config.triggers.longJob != draft.triggers.longJob { triggers.longJob = draft.triggers.longJob }
  if !triggers.isEmpty { patch.triggers = triggers }

  if let longJob = Int(draft.longJobSeconds), config.longJobSeconds != longJob {
    patch.longJobSeconds = longJob
  }

  var identity = ServerConfigPatch.PartialIdentity()
  if config.identity.name != draft.identity.name { identity.name = draft.identity.name }
  if config.identity.color != draft.identity.color { identity.color = draft.identity.color }
  if !identity.isEmpty { patch.identity = identity }

  var session = ServerConfigPatch.PartialSession()
  if config.session.defaultShell != draft.sessionShell {
    session.defaultShell = draft.sessionShell
  }
  if config.session.defaultCwd != draft.sessionCwd {
    session.defaultCwd = draft.sessionCwd
  }
  if let rows = Int(draft.scrollbackRows), config.session.scrollbackRows != rows {
    session.scrollbackRows = rows
  }
  if let silenceSec = Double(draft.silenceSeconds) {
    // Match RN: Number(draft.silenceMs) * 1000 (seconds → ms).
    let silenceMs = Int(silenceSec * 1000)
    if config.session.silenceMs != silenceMs {
      session.silenceMs = silenceMs
    }
  }
  if !session.isEmpty { patch.session = session }
  return patch
}

public func isServerSettingsDirty(config: ServerConfig, draft: ServerSettingsDraft) -> Bool {
  !patchForDraft(config: config, draft: draft).isEmpty
}

public func validateServerSettingsDraft(
  _ draft: ServerSettingsDraft
) -> [ServerSettingsFieldError: String] {
  var errors: [ServerSettingsFieldError: String] = [:]
  if draft.identity.name.isEmpty || draft.identity.name.count > 100 {
    errors[.identityName] = "Name must be between 1 and 100 characters."
  }
  if draft.identity.color.count > 32 {
    errors[.identityColor] = "Color must be at most 32 characters."
  }
  if let longJob = Int(draft.longJobSeconds), longJob > 0 {
  } else {
    errors[.longJobSeconds] = "Long-job threshold must be a positive whole number."
  }
  if draft.sessionShell.isEmpty || draft.sessionShell.count > 4096 {
    errors[.defaultShell] = "Default shell must be between 1 and 4096 characters."
  }
  if draft.sessionCwd.isEmpty || draft.sessionCwd.count > 4096 {
    errors[.defaultCwd] = "Default directory must be between 1 and 4096 characters."
  }
  if let rows = Int(draft.scrollbackRows), rows >= 100, rows <= 100_000 {
  } else {
    errors[.scrollbackRows] = "Scrollback must be between 100 and 100000 rows."
  }
  if let silenceSec = Double(draft.silenceSeconds), silenceSec >= 1, silenceSec <= 3600 {
    let ms = silenceSec * 1000
    if ms != ms.rounded() {
      errors[.silenceMs] = "Enter seconds to the nearest millisecond."
    }
  } else {
    errors[.silenceMs] = "Enter a value from 1 to 3600 seconds."
  }
  return errors
}

public func pushStatusHint(enabled: Bool, deviceCount: Int) -> String {
  if !enabled {
    return "Off. Nothing is sent to Apple, and no notification leaves this server."
  }
  if deviceCount == 0 {
    return
      "On, but no device has registered yet. Allow notifications when the app asks, then reopen this screen."
  }
  let devices = "\(deviceCount) device\(deviceCount == 1 ? "" : "s")"
  return "On. Notifications go to \(devices), encrypted so the relay cannot read them."
}

public struct AdminOkResponse: Codable, Equatable, Sendable {
  public var ok: Bool
  public var targetVersion: String?
  public var error: String?
}

public struct HealthVersionResponse: Codable, Equatable, Sendable {
  public var ok: Bool?
  public var version: String?
}

public enum ConfigClientError: Error, LocalizedError {
  case serverMessage(String)

  public var errorDescription: String? {
    switch self {
    case let .serverMessage(message):
      message
    }
  }
}

// MARK: - NativeHostClient config + admin API
//
// Mirrors GitClient.swift / PushClient.swift: request construction is duplicated
// from the public `profile` + bearer source (file-private on the actor).

extension NativeHostClient {
  public func fetchServerConfig() async throws -> ServerConfig {
    let request = try await configRequest(path: "/api/config")
    return try await decodeConfig(ServerConfig.self, request: request)
  }

  public func patchServerConfig(_ patch: ServerConfigPatch) async throws -> ServerConfig {
    let body = try JSONSerialization.data(withJSONObject: patch.jsonObject())
    let request = try await configRequest(path: "/api/config", method: "PATCH", body: body)
    return try await decodeConfig(ServerConfig.self, request: request)
  }

  public func fetchServerVersion() async throws -> String? {
    let request = try await configRequest(path: "/api/health")
    let body = try await decodeConfig(HealthVersionResponse.self, request: request)
    return body.version
  }

  public func updateServer() async throws -> AdminOkResponse {
    let request = try await configRequest(path: "/api/admin/update", method: "POST")
    return try await decodeConfig(AdminOkResponse.self, request: request)
  }

  public func restartServer() async throws {
    let request = try await configRequest(path: "/api/admin/restart", method: "POST")
    _ = try await decodeConfig(AdminOkResponse.self, request: request)
  }

  public func sendTestNotification() async throws {
    let empty: [String: Any] = [:]
    let body = try JSONSerialization.data(withJSONObject: empty)
    let request = try await configRequest(
      path: "/api/admin/test-notification",
      method: "POST",
      body: body)
    let result = try await decodeConfig(AdminOkResponse.self, request: request)
    if result.ok == false {
      throw ConfigClientError.serverMessage(
        result.error ?? "Notification delivery failed."
      )
    }
  }

  // MARK: Private helpers

  private func configRequest(
    path: String,
    method: String = "GET",
    body: Data? = nil
  ) async throws -> URLRequest {
    guard let base = profile.baseHTTPURL else { throw HostClientError.invalidURL }
    let url = base.appendingPathComponent(
      path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    )
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(try await bearerValue())", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }

  private func decodeConfig<T: Decodable>(_ type: T.Type, request: URLRequest) async throws -> T {
    let (data, status) = try await sendAuthorized(request: request)
    guard status != 401 else { throw HostClientError.unauthorized }
    if !(200..<300).contains(status) {
      if let message = Self.serverErrorMessage(from: data) {
        throw ConfigClientError.serverMessage(message)
      }
      throw HostClientError.httpStatus(status)
    }
    guard let decoded = try? JSONDecoder().decode(type, from: data) else {
      throw HostClientError.decodeFailed
    }
    return decoded
  }

  private static func serverErrorMessage(from data: Data) -> String? {
    struct Body: Decodable {
      var error: String?
      var ok: Bool?
    }
    guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return nil }
    if let error = body.error, !error.isEmpty { return error }
    return nil
  }
}
