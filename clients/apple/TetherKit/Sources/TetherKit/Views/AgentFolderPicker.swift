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
