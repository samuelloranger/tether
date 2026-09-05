import Foundation

// MARK: - Response models (shapes from workspaceFile.ts / files.ts / presentations.ts)

public struct WorkspaceFileContent: Codable, Equatable, Sendable {
  public var path: String
  public var content: String

  public init(path: String, content: String) {
    self.path = path
    self.content = content
  }
}

public struct WorkspaceFileView: Equatable, Sendable {
  public var path: String
  public var content: String
  public var line: Int?
  public var column: Int?

  public init(path: String, content: String, line: Int? = nil, column: Int? = nil) {
    self.path = path
    self.content = content
    self.line = line
    self.column = column
  }
}

public struct UploadResponse: Codable, Equatable, Sendable {
  public var ok: Bool
  public var path: String?
  public var error: String?

  public init(ok: Bool, path: String? = nil, error: String? = nil) {
    self.ok = ok
    self.path = path
    self.error = error
  }
}

public struct Presentation: Codable, Equatable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public var project: String
  public var revision: Int
  public var url: String
  public var sessionId: String?

  public init(
    id: String,
    title: String,
    project: String,
    revision: Int,
    url: String,
    sessionId: String? = nil
  ) {
    self.id = id
    self.title = title
    self.project = project
    self.revision = revision
    self.url = url
    self.sessionId = sessionId
  }
}

public struct PresentationCloseResponse: Codable, Equatable, Sendable {
  public var ok: Bool
}

public enum WorkspaceClientError: Error, LocalizedError, Sendable {
  case invalidURL
  case missingPassword
  case unauthorized
  case httpStatus(Int)
  case decodeFailed
  /// A non-2xx reply whose body carried the server's own `{"error": …}` text.
  ///
  /// Discarding that text is how `file not found` reached the user as
  /// "Server returned HTTP 404". The server already says something useful;
  /// relay it — same shape as `HostClientError.server`.
  case server(status: Int, message: String)

  public var errorDescription: String? {
    switch self {
    case .invalidURL:
      "Invalid server URL"
    case .missingPassword:
      "No password stored for this host"
    case .unauthorized:
      "Unauthorized — check the password"
    case let .httpStatus(code):
      "Server returned HTTP \(code)"
    case .decodeFailed:
      "Could not decode server response"
    case let .server(_, message):
      message
    }
  }
}

// MARK: - Pure helpers (mirrors apps/mobile presentations.ts / fileView.ts / shell.ts)

/// 0-based line index clamped to the content, matching `lineOffset` in fileView.ts.
public func workspaceLineOffset(content: String, line: Int?) -> Int {
  let lineCount = max(1, content.split(separator: "\n", omittingEmptySubsequences: false).count)
  let target = (line ?? 1) - 1
  return max(0, min(lineCount - 1, target))
}

/// Quotes a value for insertion into an interactive POSIX shell.
public func shellQuote(_ value: String) -> String {
  "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
}

public func previewURL(base: URL, relativePath: String) -> URL? {
  URL(string: relativePath, relativeTo: base)?.absoluteURL
}

public func findSessionPreview(
  presentations: [Presentation],
  sessionId: String
) -> Presentation? {
  var match: Presentation?
  for preview in presentations where preview.sessionId == sessionId {
    match = preview
  }
  return match
}

public func pickAutoSelectPreview(
  rows: [Presentation],
  seen: Set<String>,
  activeId: String
) -> Presentation? {
  rows.first { !seen.contains($0.id) && $0.sessionId == activeId }
}

// MARK: - File tree nodes (port of apps/mobile/src/diffModel.ts buildFileTree)

public enum FileTreeNode: Identifiable, Equatable, Sendable {
  case dir(name: String, path: String, children: [FileTreeNode])
  case file(name: String, path: String, file: DiffFileStat)

  public var id: String {
    switch self {
    case let .dir(_, path, _): "d:\(path)"
    case let .file(_, path, file):
      "f:\(file.staged == true ? "S" : "U"):\(path)"
    }
  }

  public var path: String {
    switch self {
    case let .dir(_, path, _), let .file(_, path, _): path
    }
  }

  public var name: String {
    switch self {
    case let .dir(name, _, _), let .file(name, _, _): name
    }
  }
}

/// Nested folder tree from flat paths — `src/a/b.ts` becomes src → a → b.ts.
public func buildFileTree(files: [DiffFileStat]) -> [FileTreeNode] {
  final class DirBox {
    let name: String
    let path: String
    var children: [AnyNode] = []
    init(name: String, path: String) {
      self.name = name
      self.path = path
    }
  }
  enum AnyNode {
    case dir(DirBox)
    case file(name: String, path: String, file: DiffFileStat)
  }

  var root: [AnyNode] = []
  var dirIndex: [String: DirBox] = [:]

  for file in files {
    let segments = file.path.split(separator: "/").map(String.init)
    guard let fileName = segments.last else { continue }

    // nil means "append into root"; otherwise append into that dir's children.
    var parent: DirBox?
    var currentPath = ""

    for i in 0..<(segments.count - 1) {
      let segment = segments[i]
      currentPath = currentPath.isEmpty ? segment : "\(currentPath)/\(segment)"
      if let existing = dirIndex[currentPath] {
        parent = existing
        continue
      }
      let box = DirBox(name: segment, path: currentPath)
      dirIndex[currentPath] = box
      if let parent {
        parent.children.append(.dir(box))
      } else {
        root.append(.dir(box))
      }
      parent = box
    }

    let fileNode = AnyNode.file(name: fileName, path: file.path, file: file)
    if let parent {
      parent.children.append(fileNode)
    } else {
      root.append(fileNode)
    }
  }

  func convert(_ nodes: [AnyNode]) -> [FileTreeNode] {
    nodes.map { node in
      switch node {
      case let .dir(box):
        .dir(name: box.name, path: box.path, children: convert(box.children))
      case let .file(name, path, file):
        .file(name: name, path: path, file: file)
      }
    }
  }
  return convert(root)
}

// MARK: - NativeHostClient workspace / upload / presentations API

extension NativeHostClient {
  /// GET `/api/sessions/:id/file?path=` — returns UTF-8 text or a server error message.
  public func fetchWorkspaceFile(
    sessionId: String,
    path: String
  ) async throws -> WorkspaceFileContent {
    let request = try await workspaceRequest(
      path: "/api/sessions/\(sessionId)/file",
      queryItems: [URLQueryItem(name: "path", value: path)]
    )
    return try await decodeWorkspace(WorkspaceFileContent.self, request: request)
  }

  /// POST `/api/sessions/:id/upload` multipart (`file` + optional `filename`).
  public func uploadSessionFile(
    sessionId: String,
    data: Data,
    filename: String,
    mimeType: String = "application/octet-stream",
    onProgress: (@Sendable (Double) -> Void)? = nil
  ) async throws -> String {
    let boundary = "tether-\(UUID().uuidString)"
    let body = multipartFormBody(
      fileData: data,
      filename: filename,
      mimeType: mimeType,
      boundary: boundary
    )
    var request = try await workspaceRequest(
      path: "/api/sessions/\(sessionId)/upload",
      method: "POST"
    )
    request.setValue(
      "multipart/form-data; boundary=\(boundary)",
      forHTTPHeaderField: "Content-Type"
    )
    // Body is passed to upload(for:from:) — do not also set httpBody.

    let (responseData, response): (Data, URLResponse)
    if let onProgress {
      let delegate = UploadProgressDelegate(onProgress: onProgress)
      let session = URLSession(
        configuration: .ephemeral,
        delegate: delegate,
        delegateQueue: nil
      )
      defer { session.finishTasksAndInvalidate() }
      (responseData, response) = try await session.upload(for: request, from: body)
    } else {
      (responseData, response) = try await URLSession.shared.upload(for: request, from: body)
    }

    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status != 401 else { throw WorkspaceClientError.unauthorized }
    guard let decoded = try? JSONDecoder().decode(UploadResponse.self, from: responseData) else {
      throw WorkspaceClientError.decodeFailed
    }
    guard decoded.ok, let path = decoded.path else {
      throw WorkspaceClientError.server(
        status: status,
        message: decoded.error ?? "upload failed"
      )
    }
    return path
  }

  public func listPresentations() async throws -> [Presentation] {
    let request = try await workspaceRequest(path: "/api/presentations")
    return try await decodeWorkspace([Presentation].self, request: request)
  }

  public func closePresentation(id: String) async throws -> Bool {
    let request = try await workspaceRequest(
      path: "/api/presentations/\(id)",
      method: "DELETE"
    )
    let decoded = try await decodeWorkspace(PresentationCloseResponse.self, request: request)
    return decoded.ok
  }

  // MARK: Private helpers

  private func workspaceRequest(
    path: String,
    method: String = "GET",
    body: Data? = nil,
    queryItems: [URLQueryItem]? = nil
  ) async throws -> URLRequest {
    guard let base = profile.baseHTTPURL else { throw WorkspaceClientError.invalidURL }
    var url = base.appendingPathComponent(
      path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    )
    if let queryItems, !queryItems.isEmpty {
      guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        throw WorkspaceClientError.invalidURL
      }
      components.queryItems = queryItems
      guard let withQuery = components.url else { throw WorkspaceClientError.invalidURL }
      url = withQuery
    }
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

  private func decodeWorkspace<T: Decodable>(
    _ type: T.Type,
    request: URLRequest
  ) async throws -> T {
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      // Same reader as the git/host path — one place that knows `{"error":…}`.
      switch hostClientError(status: status, data: data) {
      case let .server(code, message):
        throw WorkspaceClientError.server(status: code, message: message)
      case .unauthorized:
        throw WorkspaceClientError.unauthorized
      case let .httpStatus(code):
        throw WorkspaceClientError.httpStatus(code)
      default:
        throw WorkspaceClientError.httpStatus(status)
      }
    }
    guard let decoded = try? JSONDecoder().decode(type, from: data) else {
      throw WorkspaceClientError.decodeFailed
    }
    return decoded
  }
}

private func multipartFormBody(
  fileData: Data,
  filename: String,
  mimeType: String,
  boundary: String
) -> Data {
  let safeName = filename.replacingOccurrences(of: "\"", with: "_")
  var body = Data()
  func append(_ string: String) {
    if let data = string.data(using: .utf8) { body.append(data) }
  }
  append("--\(boundary)\r\n")
  append("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n")
  append("Content-Type: \(mimeType)\r\n\r\n")
  body.append(fileData)
  append("\r\n")
  append("--\(boundary)\r\n")
  append("Content-Disposition: form-data; name=\"filename\"\r\n\r\n")
  append("\(safeName)\r\n")
  append("--\(boundary)--\r\n")
  return body
}

private final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
  private let onProgress: @Sendable (Double) -> Void

  init(onProgress: @escaping @Sendable (Double) -> Void) {
    self.onProgress = onProgress
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64,
    totalBytesExpectedToSend: Int64
  ) {
    guard totalBytesExpectedToSend > 0 else { return }
    onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
  }
}
