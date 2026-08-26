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
    let adapter = HostStoreAdapter()
    guard let password = try? adapter.password(for: host.id), !password.isEmpty else {
      return nil
    }
    return NativeHostClient(profile: host, password: password)
  }

  public func loadWorkspaceFile(
    path: String,
    line: Int? = nil,
    column: Int? = nil
  ) async -> WorkspaceFileView? {
    guard let sessionId = activeSessionId, let client = makeWorkspaceClient() else {
      return nil
    }
    do {
      let body = try await client.fetchWorkspaceFile(sessionId: sessionId, path: path)
      return WorkspaceFileView(
        path: body.path,
        content: body.content,
        line: line,
        column: column
      )
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
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
  public var fileError: String?

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
    fileLoading = true
    fileError = nil
    defer { fileLoading = false }
    if let view = await store.loadWorkspaceFile(path: path, line: line, column: column) {
      fileView = view
    } else {
      fileError = store.errorMessage ?? "Could not open file"
      fileView = nil
    }
  }

  public func closeFile() {
    fileView = nil
    fileError = nil
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
