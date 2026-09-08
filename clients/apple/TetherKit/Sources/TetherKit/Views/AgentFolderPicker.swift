import SwiftUI

public struct AgentFolder: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let path: String
  public let isRepo: Bool
  public init(name: String, path: String, isRepo: Bool) {
    self.id = path
    self.name = name
    self.path = path
    self.isRepo = isRepo
  }
}

/// Choose the folder a new agent chat runs in. In the app this is fed by the
/// workspace file tree; the chat starts (`agent.start {cwd}`) once a folder is
/// picked.
public struct AgentFolderPicker: View {
  public let folders: [AgentFolder]
  public let onPick: (AgentFolder) -> Void

  public init(folders: [AgentFolder], onPick: @escaping (AgentFolder) -> Void) {
    self.folders = folders
    self.onPick = onPick
  }

  public var body: some View {
    ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 6) {
        Text("Start a chat in…")
          .font(.system(size: 10, weight: .bold, design: .monospaced))
          .tracking(1)
          .foregroundStyle(TetherColors.textFaint)
          .padding(.horizontal, 16)
          .padding(.top, 8)
        ForEach(folders) { folder in
          Button { onPick(folder) } label: { row(folder) }
            .buttonStyle(.plain)
        }
      }
      .padding(.vertical, 8)
    }
    .background(TetherColors.background)
  }

  private func row(_ folder: AgentFolder) -> some View {
    HStack(spacing: 11) {
      Image(systemName: folder.isRepo ? "chevron.left.forwardslash.chevron.right" : "folder")
        .font(.callout)
        .foregroundStyle(folder.isRepo ? TetherColors.accent : TetherColors.textSecondary)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 2) {
        Text(folder.name)
          .font(.body.weight(.medium))
          .foregroundStyle(TetherColors.textPrimary)
        Text(folder.path)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(TetherColors.textFaint)
          .lineLimit(1)
          .truncationMode(.head)
      }
      Spacer(minLength: 0)
      Image(systemName: "arrow.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(TetherColors.textFaint)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 11)
    .contentShape(Rectangle())
  }
}

/// Live variant of the folder picker: walks the REAL filesystem of a named
/// host via `GET /api/fs/dirs` (`SessionStore.listDirs`), rather than the
/// static seed `AgentFolderPicker` renders for the demo/screenshot path.
/// Starts at the server's home dir; each row drills in, "Start chat here"
/// picks the CURRENT directory regardless of depth.
public struct AgentDirBrowserView: View {
  let store: SessionStore
  let hostId: String
  let onPick: (String) -> Void

  @State private var listing: DirListing?
  @State private var isLoading = true
  @State private var errorMessage: String?

  public init(store: SessionStore, hostId: String, onPick: @escaping (String) -> Void) {
    self.store = store
    self.hostId = hostId
    self.onPick = onPick
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      content
      Divider()
      Button {
        if let path = listing?.path { onPick(path) }
      } label: {
        Text("Start chat here")
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
      }
      .buttonStyle(.borderedProminent)
      .disabled(listing == nil)
      .padding(16)
    }
    .background(TetherColors.background)
    .task { await load(path: nil) }
  }

  private var header: some View {
    HStack(spacing: 8) {
      Button {
        if let parent = listing?.parent {
          Task { await load(path: parent) }
        }
      } label: {
        Image(systemName: "chevron.left")
          .tapTarget(32)
      }
      .disabled(listing?.parent == nil)
      Text(listing?.path ?? "…")
        .font(.system(.footnote, design: .monospaced))
        .foregroundStyle(TetherColors.textSecondary)
        .lineLimit(1)
        .truncationMode(.head)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  @ViewBuilder
  private var content: some View {
    if isLoading {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if let errorMessage {
      Text(errorMessage)
        .font(.footnote)
        .foregroundStyle(TetherColors.danger)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      ScrollView(.vertical) {
        LazyVStack(alignment: .leading, spacing: 2) {
          ForEach(listing?.dirs ?? []) { entry in
            Button { Task { await load(path: entry.path) } } label: { row(entry) }
              .buttonStyle(.plain)
          }
        }
        .padding(.vertical, 8)
      }
    }
  }

  private func row(_ entry: DirEntry) -> some View {
    HStack(spacing: 11) {
      Image(systemName: "folder")
        .font(.callout)
        .foregroundStyle(TetherColors.textSecondary)
        .frame(width: 22)
      Text(entry.name)
        .font(.body)
        .foregroundStyle(TetherColors.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 0)
      Image(systemName: "chevron.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(TetherColors.textFaint)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 9)
    .contentShape(Rectangle())
  }

  private func load(path: String?) async {
    isLoading = true
    errorMessage = nil
    do {
      listing = try await store.listDirs(hostId: hostId, path: path)
    } catch {
      errorMessage = error.localizedDescription
    }
    isLoading = false
  }
}
