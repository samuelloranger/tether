import Foundation

public struct RemoteSession: Identifiable, Equatable, Sendable, Codable {
  public var id: String
  public var status: String
  public var lastOutputAt: String?
  public var name: String?
  public var autoTitle: String?
  public var activity: String?

  enum CodingKeys: String, CodingKey {
    case id
    case status
    case lastOutputAt = "last_output_at"
    case name
    case autoTitle = "auto_title"
    case activity
  }

  public var displayTitle: String {
    if let name, !name.isEmpty { return name }
    if let autoTitle, !autoTitle.isEmpty { return autoTitle }
    return id
  }

  public var isRunning: Bool { status == "running" }
}

public struct ServerStatus: Decodable, Sendable {
  public var needsSetup: Bool
  public var secure: Bool?
  public var tls: TLSInfo?

  enum CodingKeys: String, CodingKey {
    case needsSetup = "needsSetup"
    case secure
    case tls
  }

  public struct TLSInfo: Decodable, Sendable {
    public var fingerprint: String?
  }
}

public struct ServerIdentity: Decodable, Sendable {
  public var name: String
  public var color: String
}

public struct ConfigResponse: Decodable, Sendable {
  public var identity: ServerIdentity?
}

public enum HostClientError: Error, LocalizedError {
  case invalidURL
  case httpStatus(Int)
  case decodeFailed
  case unauthorized
  case missingPassword

  public var errorDescription: String? {
    switch self {
    case .invalidURL:
      "Invalid server URL"
    case let .httpStatus(code):
      "Server returned HTTP \(code)"
    case .decodeFailed:
      "Could not decode server response"
    case .unauthorized:
      "Unauthorized — check the password"
    case .missingPassword:
      "No password stored for this host"
    }
  }
}

/// REST + WebSocket transport for v1 JSON protocol. Session logic will move into
/// tether-ffi as the core exports expand; this stays in the shell transport layer.
public actor NativeHostClient {
  public let profile: HostProfileModel
  private let password: String
  private let session: URLSession

  public init(profile: HostProfileModel, password: String, session: URLSession = .shared) {
    self.profile = profile
    self.password = password
    self.session = session
  }

  private func url(path: String) throws -> URL {
    guard let base = profile.baseHTTPURL else { throw HostClientError.invalidURL }
    return base.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
  }

  private func authorizedRequest(url: URL, method: String = "GET", body: Data? = nil) -> URLRequest {
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(password)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }

  public func fetchStatus() async throws -> ServerStatus {
    let request = URLRequest(url: try url(path: "/api/status"))
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
    guard let decoded = try? JSONDecoder().decode(ServerStatus.self, from: data) else {
      throw HostClientError.decodeFailed
    }
    return decoded
  }

  public func setup(password newPassword: String) async throws {
    let body = try JSONEncoder().encode(["password": newPassword])
    let request = authorizedRequest(url: try url(path: "/api/setup"), method: "POST", body: body)
    let (_, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
  }

  public func testConnection() async throws -> Int {
    let request = authorizedRequest(url: try url(path: "/api/health"))
    let (_, response) = try await session.data(for: request)
    return (response as? HTTPURLResponse)?.statusCode ?? 0
  }

  public func loadIdentity() async throws -> ServerIdentity {
    let request = authorizedRequest(url: try url(path: "/api/config"))
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
    guard
      let decoded = try? JSONDecoder().decode(ConfigResponse.self, from: data),
      let identity = decoded.identity
    else {
      throw HostClientError.decodeFailed
    }
    return identity
  }

  public func listSessions() async throws -> [RemoteSession] {
    let request = authorizedRequest(url: try url(path: "/api/sessions"))
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status != 401 else { throw HostClientError.unauthorized }
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
    guard let decoded = try? JSONDecoder().decode([RemoteSession].self, from: data) else {
      throw HostClientError.decodeFailed
    }
    return decoded
  }

  public func startSession(id: String, cwd: String = "") async throws -> RemoteSession {
    let payload = ["id": id, "cwd": cwd]
    let body = try JSONSerialization.data(withJSONObject: payload)
    let request = authorizedRequest(url: try url(path: "/api/sessions/start"), method: "POST", body: body)
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
    // The server wraps this one: { ok, session }. Decoding RemoteSession
    // straight from the body always failed, and it failed AFTER the session
    // had been created — so the tap started a session the app then refused to
    // switch to.
    guard let decoded = try? JSONDecoder().decode(StartSessionResponse.self, from: data) else {
      throw HostClientError.decodeFailed
    }
    return decoded.session
  }

  private struct StartSessionResponse: Decodable {
    var ok: Bool
    var session: RemoteSession
  }

  public func killSession(id: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["id": id])
    let request = authorizedRequest(url: try url(path: "/api/sessions/kill"), method: "POST", body: body)
    let (_, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
  }

  public func renameSession(id: String, name: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["id": id, "name": name])
    let request = authorizedRequest(url: try url(path: "/api/sessions/rename"), method: "POST", body: body)
    let (_, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
  }

  public func openWebSocket(
    sessionId: String,
    sinceId: UInt64,
    cols: UInt16,
    rows: UInt16
  ) throws -> URLSessionWebSocketTask {
    guard var components = profile.baseWSURL.flatMap({
      URLComponents(url: $0.appendingPathComponent("/api/ws"), resolvingAgainstBaseURL: false)
    }) else {
      throw HostClientError.invalidURL
    }
    components.queryItems = [
      URLQueryItem(name: "sessionId", value: sessionId),
      URLQueryItem(name: "sinceId", value: String(sinceId)),
      URLQueryItem(name: "cols", value: String(cols)),
      URLQueryItem(name: "rows", value: String(rows)),
    ]
    guard let wsURL = components.url else { throw HostClientError.invalidURL }
    var request = URLRequest(url: wsURL)
    request.setValue("Bearer \(password)", forHTTPHeaderField: "Authorization")
    return session.webSocketTask(with: request)
  }
}
