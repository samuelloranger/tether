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
  /// A non-2xx reply whose body carried the server's own `{"error": …}` text.
  ///
  /// Discarding that text is how `not a git repository` reached the user as
  /// "Server returned HTTP 404" — and, in the git sheet, as "No uncommitted
  /// changes". The server already says something useful; relay it.
  case server(status: Int, message: String)
  case decodeFailed
  case unauthorized
  case missingPassword

  public var errorDescription: String? {
    switch self {
    case .invalidURL:
      "Invalid server URL"
    case let .httpStatus(code):
      "Server returned HTTP \(code)"
    case let .server(_, message):
      message
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
  private let bearerSource: HostBearerSource
  private let session: URLSession

  public init(
    profile: HostProfileModel,
    bearerSource: HostBearerSource,
    session: URLSession = .shared
  ) {
    self.profile = profile
    self.bearerSource = bearerSource
    self.session = session
  }

  private func url(path: String) throws -> URL {
    guard let base = profile.baseHTTPURL else { throw HostClientError.invalidURL }
    return base.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
  }

  private func bearerValue() async throws -> String {
    try await bearerSource.currentBearer()
  }

  private func invalidateBearer() async {
    await bearerSource.invalidateBearer()
  }

  private func authorizedRequest(url: URL, method: String = "GET", body: Data? = nil) async throws -> URLRequest {
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

  /// A 401 triggers exactly one silent re-mint (invalidate the cached token,
  /// mint a fresh one) and retry; a second 401 surfaces to the caller.
  private func sendAuthorized(
    url: URL,
    method: String = "GET",
    body: Data? = nil
  ) async throws -> (Data, Int) {
    let request = try await authorizedRequest(url: url, method: method, body: body)
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 401 else {
      return (data, status)
    }
    await invalidateBearer()
    let retry = try await authorizedRequest(url: url, method: method, body: body)
    let (retryData, retryResponse) = try await session.data(for: retry)
    let retryStatus = (retryResponse as? HTTPURLResponse)?.statusCode ?? 0
    return (retryData, retryStatus)
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

  public func testConnection() async throws -> Int {
    let (_, status) = try await sendAuthorized(url: try url(path: "/api/health"))
    return status
  }

  public func loadIdentity() async throws -> ServerIdentity {
    let (data, status) = try await sendAuthorized(url: try url(path: "/api/config"))
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
    let (data, status) = try await sendAuthorized(url: try url(path: "/api/sessions"))
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
    let (data, status) = try await sendAuthorized(url: try url(path: "/api/sessions/start"), method: "POST", body: body)
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
    let (_, status) = try await sendAuthorized(url: try url(path: "/api/sessions/kill"), method: "POST", body: body)
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
  }

  public func renameSession(id: String, name: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["id": id, "name": name])
    let (_, status) = try await sendAuthorized(url: try url(path: "/api/sessions/rename"), method: "POST", body: body)
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
  }

  public func openWebSocket(
    sessionId: String,
    sinceId: UInt64,
    cols: UInt16,
    rows: UInt16
  ) async throws -> URLSessionWebSocketTask {
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
    request.setValue("Bearer \(try await bearerValue())", forHTTPHeaderField: "Authorization")
    return session.webSocketTask(with: request)
  }
}

/// The server's own error text for a failed response, when it sent one.
///
/// Every route answers a failure as `{"error": "..."}`, so one reader covers
/// them all. Falls back to the bare status when the body is not that shape.
func hostClientError(status: Int, data: Data) -> HostClientError {
  if status == 401 { return .unauthorized }
  if
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let message = object["error"] as? String,
    !message.isEmpty
  {
    return .server(status: status, message: message)
  }
  return .httpStatus(status)
}
