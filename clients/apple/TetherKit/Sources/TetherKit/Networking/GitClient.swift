import Foundation

// MARK: - Response models (shapes from apps/server gitDiff.ts / gitOps.ts)

public struct DiffFileStat: Codable, Equatable, Sendable, Identifiable {
  public var path: String
  public var insertions: Int
  public var deletions: Int
  public var binary: Bool
  /// Index (staged) vs working-tree (unstaged). Absent on older servers.
  public var staged: Bool?
  /// Whether the file is untracked. Absent on older servers.
  public var untracked: Bool?

  public var id: String {
    "\(staged == true ? "S" : "U"):\(path)"
  }

  public init(
    path: String,
    insertions: Int,
    deletions: Int,
    binary: Bool,
    staged: Bool? = nil,
    untracked: Bool? = nil
  ) {
    self.path = path
    self.insertions = insertions
    self.deletions = deletions
    self.binary = binary
    self.staged = staged
    self.untracked = untracked
  }

  /// git-status letter for the row.
  ///
  /// This was inferred from the counts, which marked any pure-addition edit to
  /// a tracked file as "A" — the most common kind of edit there is. The server
  /// now states whether the file is untracked.
  public var statusLetter: String {
    if binary { return "B" }
    if untracked == true { return "A" }
    if insertions == 0 && deletions > 0 { return "D" }
    return "M"
  }
}

public struct DiffSummary: Codable, Equatable, Sendable {
  public var files: [DiffFileStat]

  public init(files: [DiffFileStat] = []) {
    self.files = files
  }
}

public struct DiffTextResponse: Codable, Equatable, Sendable {
  public var diff: String
  public var truncated: Bool

  public init(diff: String, truncated: Bool) {
    self.diff = diff
    self.truncated = truncated
  }
}

public struct GitLogEntry: Codable, Equatable, Hashable, Sendable, Identifiable {
  public var sha: String
  public var shortSha: String
  public var author: String
  public var date: String
  public var subject: String

  public var id: String { sha }
}

public struct GitOkResponse: Codable, Equatable, Sendable {
  public var ok: Bool
}

public enum GitDiffMode: String, Sendable, Hashable {
  case head
  case staged
  case unstaged
}

public enum DiffBlobSide: String, Sendable, Hashable {
  case old
  case new
}

// MARK: - NativeHostClient git API
//
// Mirrors PushClient.swift: `url` / `authorizedRequest` / `session` are
// file-private on NativeHostClient, so request construction is duplicated here
// from the public `profile` + Keychain (same account the client was built with).

extension NativeHostClient {
  public func fetchDiffSummary(sessionId: String) async throws -> DiffSummary {
    let request = try gitRequest(
      path: "/api/sessions/\(sessionId)/diff/summary")
    return try await decode(DiffSummary.self, request: request)
  }

  /// Unified diff text for one path (or the whole tree when `path` is nil).
  public func fetchDiff(
    sessionId: String,
    path: String? = nil,
    mode: GitDiffMode = .head
  ) async throws -> DiffTextResponse {
    var items: [URLQueryItem] = []
    if let path {
      items.append(URLQueryItem(name: "path", value: path))
    }
    if mode != .head {
      items.append(URLQueryItem(name: "mode", value: mode.rawValue))
    }
    let request = try gitRequest(
      path: "/api/sessions/\(sessionId)/diff",
      queryItems: items.isEmpty ? nil : items)
    return try await decode(DiffTextResponse.self, request: request)
  }

  public func stagePath(sessionId: String, path: String) async throws {
    try await postGitOp(sessionId: sessionId, op: "stage", path: path)
  }

  public func unstagePath(sessionId: String, path: String) async throws {
    try await postGitOp(sessionId: sessionId, op: "unstage", path: path)
  }

  public func discardPath(sessionId: String, path: String) async throws {
    try await postGitOp(sessionId: sessionId, op: "discard", path: path)
  }

  public func stageAll(sessionId: String) async throws {
    try await postEmpty(path: "/api/sessions/\(sessionId)/git/stage-all")
  }

  public func unstageAll(sessionId: String) async throws {
    try await postEmpty(path: "/api/sessions/\(sessionId)/git/unstage-all")
  }

  public func discardAll(sessionId: String) async throws {
    try await postEmpty(path: "/api/sessions/\(sessionId)/git/discard-all")
  }

  public func fetchGitLog(sessionId: String, limit: Int = 50) async throws -> [GitLogEntry] {
    let request = try gitRequest(
      path: "/api/sessions/\(sessionId)/git/log",
      queryItems: [URLQueryItem(name: "limit", value: String(limit))])
    return try await decode([GitLogEntry].self, request: request)
  }

  /// Patch for one commit (`GET …/git/commit/:sha/diff`).
  public func fetchCommitDiff(
    sessionId: String,
    sha: String,
    path: String? = nil
  ) async throws -> DiffTextResponse {
    var items: [URLQueryItem] = []
    if let path {
      items.append(URLQueryItem(name: "path", value: path))
    }
    let request = try gitRequest(
      path: "/api/sessions/\(sessionId)/git/commit/\(sha)/diff",
      queryItems: items.isEmpty ? nil : items)
    return try await decode(DiffTextResponse.self, request: request)
  }

  /// Raw bytes for one side of a binary/image diff (`GET …/diff/file`).
  /// Returns `nil` when that side is absent (added/deleted file → 404).
  public func fetchDiffBlob(
    sessionId: String,
    path: String,
    side: DiffBlobSide
  ) async throws -> Data? {
    let request = try gitRequest(
      path: "/api/sessions/\(sessionId)/diff/file",
      queryItems: [
        URLQueryItem(name: "path", value: path),
        URLQueryItem(name: "side", value: side.rawValue),
      ])
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 404 { return nil }
    guard status != 401 else { throw HostClientError.unauthorized }
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
    return data
  }

  public func commitStaged(
    sessionId: String,
    message: String,
    amend: Bool = false
  ) async throws {
    var payload: [String: Any] = ["message": message]
    if amend { payload["amend"] = true }
    let body = try JSONSerialization.data(withJSONObject: payload)
    let request = try gitRequest(
      path: "/api/sessions/\(sessionId)/git/commit",
      method: "POST",
      body: body)
    _ = try await decode(GitOkResponse.self, request: request)
  }

  public func undoLastCommit(sessionId: String) async throws {
    try await postEmpty(path: "/api/sessions/\(sessionId)/git/undo-commit")
  }

  public func pushBranch(sessionId: String) async throws {
    try await postEmpty(path: "/api/sessions/\(sessionId)/git/push")
  }

  public func stageHunk(sessionId: String, path: String, hunkIndex: Int) async throws {
    try await postHunk(sessionId: sessionId, op: "stage-hunk", path: path, hunkIndex: hunkIndex)
  }

  public func unstageHunk(sessionId: String, path: String, hunkIndex: Int) async throws {
    try await postHunk(sessionId: sessionId, op: "unstage-hunk", path: path, hunkIndex: hunkIndex)
  }

  // MARK: Private helpers

  private func postGitOp(sessionId: String, op: String, path: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["path": path])
    let request = try gitRequest(
      path: "/api/sessions/\(sessionId)/git/\(op)",
      method: "POST",
      body: body)
    _ = try await decode(GitOkResponse.self, request: request)
  }

  private func postHunk(
    sessionId: String,
    op: String,
    path: String,
    hunkIndex: Int
  ) async throws {
    let body = try JSONSerialization.data(withJSONObject: [
      "path": path,
      "hunkIndex": hunkIndex,
    ])
    let request = try gitRequest(
      path: "/api/sessions/\(sessionId)/git/\(op)",
      method: "POST",
      body: body)
    _ = try await decode(GitOkResponse.self, request: request)
  }

  private func postEmpty(path: String) async throws {
    let request = try gitRequest(path: path, method: "POST")
    _ = try await decode(GitOkResponse.self, request: request)
  }

  private func gitRequest(
    path: String,
    method: String = "GET",
    body: Data? = nil,
    queryItems: [URLQueryItem]? = nil
  ) throws -> URLRequest {
    guard let base = profile.baseHTTPURL else { throw HostClientError.invalidURL }
    var url = base.appendingPathComponent(
      path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    )
    if let queryItems, !queryItems.isEmpty {
      guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        throw HostClientError.invalidURL
      }
      components.queryItems = queryItems
      guard let withQuery = components.url else { throw HostClientError.invalidURL }
      url = withQuery
    }
    guard
      let password = try KeychainSecretStore().get(hostId: profile.id),
      !password.isEmpty
    else {
      throw HostClientError.missingPassword
    }
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

  private func decode<T: Decodable>(_ type: T.Type, request: URLRequest) async throws -> T {
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status != 401 else { throw HostClientError.unauthorized }
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
    guard let decoded = try? JSONDecoder().decode(type, from: data) else {
      throw HostClientError.decodeFailed
    }
    return decoded
  }
}
