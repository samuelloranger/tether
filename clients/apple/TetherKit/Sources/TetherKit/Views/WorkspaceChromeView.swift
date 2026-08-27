import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Banner announcing a pushed preview for the active session.
///
/// Deliberately NOT part of WorkspaceChromeView: that is a ZStack overlay above
/// the whole app, so a banner inside it drew on top of the title bar. This one
/// belongs in the layout flow, directly under the title bar.
public struct PresentationBannerSlot: View {
  @Bindable public var store: SessionStore
  @Bindable public var workspace: WorkspaceController

  public init(store: SessionStore, workspace: WorkspaceController) {
    self.store = store
    self.workspace = workspace
  }

  public var body: some View {
    if workspace.activePresentation == nil,
       workspace.fileView == nil,
       let sessionId = store.activeSessionId,
       let preview = findSessionPreview(
         presentations: workspace.presentations,
         sessionId: sessionId
       )
    {
      PresentationBannerView(
        label: "Preview ready: \(preview.title)",
        systemImage: "rectangle.on.rectangle",
        onPress: { workspace.selectPresentation(id: preview.id) }
      )
    }
  }
}

/// Overlay chrome for workspace file viewer, presentations, and uploads.
public struct WorkspaceChromeView: View {
  @Bindable public var store: SessionStore
  @Bindable public var workspace: WorkspaceController

  @State private var photoItem: PhotosPickerItem?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(store: SessionStore, workspace: WorkspaceController) {
    self.store = store
    self.workspace = workspace
  }

  /// Full-screen viewer when content, a load failure, or an in-flight open is
  /// active — not while the path sheet is up (that sheet owns the error text).
  private var showsFileViewer: Bool {
    if workspace.showOpenFileSheet { return false }
    return workspace.fileView != nil
      || workspace.fileError != nil
      || workspace.fileLoading
  }

  public var body: some View {
    ZStack {
      if showsFileViewer {
        FileViewerView(
          file: workspace.fileView,
          loadError: workspace.fileError,
          loading: workspace.fileLoading && workspace.fileView == nil,
          onRetry: { Task { await workspace.retryOpenFile(store: store) } },
          onBack: { workspace.closeFile() },
          pathLabel: workspace.lastOpenPath
        )
        // The viewer covers the terminal, so it comes from the side the way a
        // pushed screen does. It already declared this transition and never got
        // an animation to run it on, so the file viewer appeared by hard cut.
        .transition(reduceMotion ? .opacity : .move(edge: .trailing))
      }

      if let preview = workspace.activePresentation,
         let url = store.presentationPreviewURL(preview)
      {
        PresentationPaneView(
          preview: preview,
          url: url,
          backLabel: store.activeSession?.displayTitle ?? "terminal",
          onBack: { workspace.clearPresentation() },
          onClose: {
            Task { await workspace.closePresentation(store: store, id: preview.id) }
          }
        )
        .transition(reduceMotion ? .opacity : .move(edge: .trailing))
      }

      if workspace.isUploading {
        uploadCover
          .transition(.opacity)
      }
    }
    .animation(
      TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion),
      value: showsFileViewer
    )
    .animation(
      TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion),
      value: workspace.activePresentation?.id
    )
    .animation(
      TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion),
      value: workspace.isUploading
    )
    .onAppear { workspace.startPolling(store: store) }
    .onDisappear { workspace.stopPolling() }
    .sheet(isPresented: $workspace.showOpenFileSheet) {
      WorkspaceOpenFileSheet(
        store: store,
        workspace: workspace,
        onDismiss: { workspace.showOpenFileSheet = false }
      )
    }
    .fileImporter(
      isPresented: $workspace.showFileImporter,
      allowedContentTypes: [.item],
      allowsMultipleSelection: false
    ) { result in
      Task { await handleFileImport(result) }
    }
    .photosPicker(
      isPresented: $workspace.showPhotosPicker,
      selection: $photoItem,
      matching: .images
    )
    .onChange(of: photoItem) { _, item in
      guard let item else { return }
      Task { await handlePhoto(item) }
    }
    .alert(
      "Upload failed",
      isPresented: Binding(
        get: { workspace.uploadError != nil },
        set: { if !$0 { workspace.uploadError = nil } }
      )
    ) {
      Button("OK", role: .cancel) { workspace.uploadError = nil }
    } message: {
      Text(workspace.uploadError ?? "")
    }
  }

  private var uploadCover: some View {
    VStack(spacing: 12) {
      if let progress = workspace.uploadProgress {
        ProgressView(value: progress)
          .tint(TetherColors.accent)
          .frame(width: 180)
        Text("Uploading \(Int(progress * 100))%")
          .font(.caption)
          .foregroundStyle(TetherColors.textSecondary)
      } else {
        ProgressView()
          .tint(TetherColors.accent)
        Text("Uploading…")
          .font(.caption)
          .foregroundStyle(TetherColors.textSecondary)
      }
    }
    .padding(24)
    .background(TetherColors.surface)
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(TetherColors.background.opacity(0.55))
  }

  private func handleFileImport(_ result: Result<[URL], Error>) async {
    switch result {
    case let .failure(error):
      workspace.uploadError = error.localizedDescription
    case let .success(urls):
      guard let url = urls.first else { return }
      let accessed = url.startAccessingSecurityScopedResource()
      defer {
        if accessed { url.stopAccessingSecurityScopedResource() }
      }
      do {
        let data = try Data(contentsOf: url)
        let name = url.lastPathComponent
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
          ?? "application/octet-stream"
        await workspace.upload(store: store, data: data, filename: name, mimeType: mime)
      } catch {
        workspace.uploadError = error.localizedDescription
      }
    }
  }

  private func handlePhoto(_ item: PhotosPickerItem) async {
    defer { photoItem = nil }
    do {
      guard let raw = try await item.loadTransferable(type: PickedImageData.self) else {
        workspace.uploadError = "Could not read the selected image"
        return
      }
      let filename = "image-\(Int(Date().timeIntervalSince1970)).jpg"
      await workspace.upload(
        store: store,
        data: raw.data,
        filename: filename,
        mimeType: "image/jpeg"
      )
    } catch {
      workspace.uploadError = error.localizedDescription
    }
  }
}

/// PhotosPicker `Data` bridge — `Data` itself is not `Transferable`.
private struct PickedImageData: Transferable {
  let data: Data

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(importedContentType: .image) { data in
      PickedImageData(data: data)
    }
  }
}
