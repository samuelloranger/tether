import SwiftUI

/// Read-only workspace file viewer — port of `apps/mobile/src/FileViewer.tsx`.
public struct FileViewerView: View {
  public var file: WorkspaceFileView?
  /// Why the last open failed, if it did. Distinct from an empty file:
  /// "nothing to show" and "could not look" must not share a view.
  public var loadError: String?
  public var loading: Bool
  public var onRetry: (() -> Void)?
  public var onBack: () -> Void
  public var backLabel: String
  /// Shown in the header when `file` is nil (e.g. a failed open still names the path).
  public var pathLabel: String?

  public init(
    file: WorkspaceFileView?,
    loadError: String? = nil,
    loading: Bool = false,
    onRetry: (() -> Void)? = nil,
    onBack: @escaping () -> Void,
    backLabel: String = "Back to terminal",
    pathLabel: String? = nil
  ) {
    self.file = file
    self.loadError = loadError
    self.loading = loading
    self.onRetry = onRetry
    self.onBack = onBack
    self.backLabel = backLabel
    self.pathLabel = pathLabel
  }

  /// Convenience for the common "already loaded" path.
  public init(
    file: WorkspaceFileView,
    onBack: @escaping () -> Void,
    backLabel: String = "Back to terminal"
  ) {
    self.init(
      file: file,
      loadError: nil,
      loading: false,
      onRetry: nil,
      onBack: onBack,
      backLabel: backLabel,
      pathLabel: nil
    )
  }

  private var lines: [String] {
    guard let file else { return [] }
    return file.content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  }

  private var targetLine: Int {
    guard let file else { return 0 }
    return workspaceLineOffset(content: file.content, line: file.line)
  }

  private var titlePath: String {
    file?.path ?? pathLabel ?? ""
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Group {
        if loading {
          ProgressView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .tint(TetherColors.accent)
        } else if let loadError {
          failureBody(loadError)
        } else if let file {
          fileBody(file)
        } else {
          Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
    .background(TetherColors.background)
  }

  private func failureBody(_ message: String) -> some View {
    VStack(spacing: 10) {
      Image(systemName: "exclamationmark.triangle")
        .font(.title2)
        .foregroundStyle(TetherColors.textSecondary)
      Text(message)
        .font(.callout)
        .multilineTextAlignment(.center)
        .foregroundStyle(TetherColors.textSecondary)
      if let onRetry {
        Button("Try again", action: onRetry)
          .font(.callout.weight(.semibold))
          .foregroundStyle(TetherColors.accent)
      }
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func fileBody(_ file: WorkspaceFileView) -> some View {
    ScrollViewReader { proxy in
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            HStack(alignment: .top, spacing: 12) {
              Text("\(index + 1)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(TetherColors.textSecondary)
                .frame(width: 40, alignment: .trailing)
              Text(line.isEmpty ? " " : line)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(TetherColors.textPrimary)
                .textSelection(.enabled)
            }
            .padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              index == targetLine && file.line != nil
                ? TetherColors.accent.opacity(0.12)
                : Color.clear
            )
            .id(index)
          }
        }
        .padding(16)
      }
      .onAppear {
        proxy.scrollTo(targetLine, anchor: .top)
      }
      .onChange(of: file.path) { _, _ in
        proxy.scrollTo(targetLine, anchor: .top)
      }
      .onChange(of: file.line) { _, _ in
        proxy.scrollTo(targetLine, anchor: .top)
      }
    }
  }

  private var header: some View {
    HStack(spacing: 12) {
      Button(action: onBack) {
        HStack(spacing: 4) {
          Image(systemName: "chevron.left")
          Text(backLabel)
            .lineLimit(1)
        }
        .font(.subheadline.weight(.semibold))
      }
      .accessibilityLabel(backLabel)

      Spacer(minLength: 8)

      Text(titlePath)
        .font(.system(.subheadline, design: .monospaced))
        .foregroundStyle(TetherColors.textPrimary)
        .lineLimit(1)
    }
    .buttonStyle(.plain)
    .foregroundStyle(TetherColors.accent)
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(TetherColors.surface)
  }
}

/// Path-entry sheet for opening a workspace file when no terminal link fired.
/// Server resolves paths relative to the session cwd / git workspace root.
public struct WorkspaceOpenFileSheet: View {
  @Bindable public var store: SessionStore
  @Bindable public var workspace: WorkspaceController
  public var onDismiss: () -> Void

  @State private var pathText = ""

  public init(
    store: SessionStore,
    workspace: WorkspaceController,
    onDismiss: @escaping () -> Void
  ) {
    self.store = store
    self.workspace = workspace
    self.onDismiss = onDismiss
  }

  public var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 16) {
        Text("Path is relative to the session working directory (inside the workspace).")
          .font(.caption)
          .foregroundStyle(TetherColors.textSecondary)

        TextField("src/main.ts", text: $pathText)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(.system(.body, design: .monospaced))
          .padding(12)
          .background(TetherColors.surface)
          .clipShape(RoundedRectangle(cornerRadius: 8))

        if let error = workspace.fileError {
          Text(error)
            .font(.caption)
            .foregroundStyle(TetherColors.danger)
        }

        Spacer()
      }
      .padding(16)
      .background(TetherColors.background)
      .navigationTitle("Open file")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onDismiss)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Open") {
            Task {
              await workspace.openFile(store: store, path: pathText.trimmingCharacters(in: .whitespaces))
              if workspace.fileView != nil {
                onDismiss()
              }
            }
          }
          .disabled(pathText.trimmingCharacters(in: .whitespaces).isEmpty || workspace.fileLoading)
        }
      }
    }
  }
}
