import SwiftUI

/// Read-only workspace file viewer — port of `apps/mobile/src/FileViewer.tsx`.
public struct FileViewerView: View {
  public var file: WorkspaceFileView
  public var onBack: () -> Void
  public var backLabel: String

  public init(
    file: WorkspaceFileView,
    onBack: @escaping () -> Void,
    backLabel: String = "Back to terminal"
  ) {
    self.file = file
    self.onBack = onBack
    self.backLabel = backLabel
  }

  private var lines: [String] {
    file.content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  }

  private var targetLine: Int {
    workspaceLineOffset(content: file.content, line: file.line)
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
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
    .background(TetherColors.background)
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

      Text(file.path)
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
