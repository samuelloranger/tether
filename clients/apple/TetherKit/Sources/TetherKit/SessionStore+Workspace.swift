import Foundation
import Observation

/// Workspace / upload / presentation helpers that cannot live in SessionStore.swift.
/// Builds a `NativeHostClient` via a fresh `HostStoreAdapter` (same pattern as git).
///
/// File / presentation / upload *state* lives on `WorkspaceController` — stored
/// properties cannot be added in a SessionStore extension.
extension SessionStore {
  public func makeWorkspaceClient() -> NativeHostClient? {
    guard let host = activeHost else { return nil }
    return client(for: host.id)
  }

  public func loadWorkspaceFile(
    path: String,
    line: Int? = nil,
    column: Int? = nil
  ) async -> WorkspaceFileView? {
    do {
      return try await fetchWorkspaceFile(path: path, line: line, column: column)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  /// Throwing variant, for callers that must tell "file is empty" from "could not
  /// look".
  ///
  /// `loadWorkspaceFile` answers `nil` for both, and the viewer / open-file
  /// sheet treated that like a soft miss — so a server reply of `path is a
  /// directory` or `file not found` never reached the screen as itself.
  public func fetchWorkspaceFile(
    path: String,
    line: Int? = nil,
    column: Int? = nil
  ) async throws -> WorkspaceFileView {
    guard let sessionId = activeSessionId else { throw WorkspaceLoadError.noSession }
    guard let client = makeWorkspaceClient() else { throw WorkspaceLoadError.noCredentials }
    let body = try await client.fetchWorkspaceFile(sessionId: sessionId, path: path)
    return WorkspaceFileView(
      path: body.path,
      content: body.content,
      line: line,
      column: column
    )
  }

  /// Uploads bytes and pastes the server path into the active terminal (quoted).
  public func uploadToSession(
    data: Data,
    filename: String,
    mimeType: String = "application/octet-stream",
    onProgress: (@Sendable (Double) -> Void)? = nil
  ) async -> String? {
    guard let sessionId = activeSessionId, let client = makeWorkspaceClient() else {
      return nil
    }
    do {
      let path = try await client.uploadSessionFile(
        sessionId: sessionId,
        data: data,
        filename: filename,
        mimeType: mimeType,
        onProgress: onProgress
      )
      sendInput(shellQuote(path))
      return path
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func loadPresentations() async -> [Presentation]? {
    guard let client = makeWorkspaceClient() else { return nil }
    do {
      return try await client.listPresentations()
    } catch {
      if let err = error as? WorkspaceClientError, case .unauthorized = err {
        errorMessage = err.localizedDescription
      }
      return nil
    }
  }

  public func closePresentationRemote(id: String) async -> Bool {
    guard let client = makeWorkspaceClient() else { return false }
    do {
      return try await client.closePresentation(id: id)
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func presentationPreviewURL(_ presentation: Presentation) -> URL? {
    guard let host = activeHost, let base = host.baseHTTPURL else { return nil }
    return previewURL(base: base, relativePath: presentation.url)
  }
}

/// Holds file-viewer / presentation / upload UI state. Owned by RootView (or
/// `WorkspaceChromeView`); not SessionStore — extensions cannot add stored props.
@Observable
@MainActor
public final class WorkspaceController {
  public var fileView: WorkspaceFileView?
  public var fileLoading = false
  /// Why the last open failed, if it did. Distinct from a missing fileView:
  /// "nothing to show" and "could not look" must not share a path.
  public var fileError: String?
  /// Path of the last open attempt — needed so "Try again" can re-request.
  public var lastOpenPath: String?

  public var presentations: [Presentation] = []
  public var activePresentationId: String?
  public var showFileImporter = false
  public var showPhotosPicker = false
  public var showOpenFileSheet = false

  public var uploadProgress: Double?
  public var uploadError: String?
  public var isUploading = false

  @ObservationIgnored private var seenPresentationIds = Set<String>()
  @ObservationIgnored private var presentationsPrimed = false
  @ObservationIgnored private var pollTask: Task<Void, Never>?
  @ObservationIgnored private var lastOpenLine: Int?
  @ObservationIgnored private var lastOpenColumn: Int?

  public init() {}

  public var activePresentation: Presentation? {
    guard let activePresentationId else { return nil }
    return presentations.first { $0.id == activePresentationId }
  }

  public func openFile(
    store: SessionStore,
    path: String,
    line: Int? = nil,
    column: Int? = nil
  ) async {
    lastOpenPath = path
    lastOpenLine = line
    lastOpenColumn = column
    fileLoading = true
    fileError = nil
    defer { fileLoading = false }
    do {
      fileView = try await store.fetchWorkspaceFile(path: path, line: line, column: column)
      fileError = nil
    } catch {
      fileError = error.localizedDescription
      fileView = nil
    }
  }

  public func retryOpenFile(store: SessionStore) async {
    guard let path = lastOpenPath else { return }
    await openFile(store: store, path: path, line: lastOpenLine, column: lastOpenColumn)
  }

  public func closeFile() {
    fileView = nil
    fileError = nil
    lastOpenPath = nil
    lastOpenLine = nil
    lastOpenColumn = nil
  }

  public func selectPresentation(id: String) {
    activePresentationId = id
  }

  public func clearPresentation() {
    activePresentationId = nil
  }

  public func closePresentation(store: SessionStore, id: String) async {
    let ok = await store.closePresentationRemote(id: id)
    if ok {
      if activePresentationId == id { activePresentationId = nil }
      await refreshPresentations(store: store)
    }
  }

  public func startPolling(store: SessionStore) {
    pollTask?.cancel()
    pollTask = Task { @MainActor in
      await refreshPresentations(store: store)
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        guard !Task.isCancelled else { break }
        await refreshPresentations(store: store)
      }
    }
  }

  public func stopPolling() {
    pollTask?.cancel()
    pollTask = nil
  }

  public func refreshPresentations(store: SessionStore) async {
    guard let rows = await store.loadPresentations() else { return }
    let activeId = store.activeSessionId ?? ""
    if !presentationsPrimed {
      presentationsPrimed = true
      seenPresentationIds = Set(rows.map(\.id))
      presentations = rows
      return
    }
    let auto = pickAutoSelectPreview(
      rows: rows,
      seen: seenPresentationIds,
      activeId: activeId
    )
    seenPresentationIds = Set(rows.map(\.id))
    presentations = rows
    if let auto {
      activePresentationId = auto.id
    } else if let current = activePresentationId,
              !rows.contains(where: { $0.id == current })
    {
      activePresentationId = nil
    }
  }

  public func upload(
    store: SessionStore,
    data: Data,
    filename: String,
    mimeType: String
  ) async {
    isUploading = true
    uploadError = nil
    uploadProgress = 0
    defer {
      isUploading = false
      uploadProgress = nil
    }
    let path = await store.uploadToSession(
      data: data,
      filename: filename,
      mimeType: mimeType,
      onProgress: { [weak self] value in
        Task { @MainActor in
          self?.uploadProgress = value
        }
      }
    )
    if path == nil {
      uploadError = store.errorMessage ?? "Upload failed"
    }
  }
}

/// Why a workspace open has nothing to show, when the reason is not the server's.
public enum WorkspaceLoadError: LocalizedError {
  case noSession
  case noCredentials

  public var errorDescription: String? {
    switch self {
    case .noSession: "Open a terminal to open a file."
    case .noCredentials: "This host needs pairing again."
    }
  }
}
