import SwiftUI

/// Nested folder tree — port of `apps/mobile/src/FileTree.tsx`.
public struct FileTreeView: View {
  public var nodes: [FileTreeNode]
  public var depth: Int
  public var collapsedDirs: Set<String>
  public var onToggleDir: (String) -> Void
  public var onSelectFile: (String) -> Void
  public var showDiffStats: Bool

  public init(
    nodes: [FileTreeNode],
    depth: Int = 0,
    collapsedDirs: Set<String>,
    onToggleDir: @escaping (String) -> Void,
    onSelectFile: @escaping (String) -> Void,
    showDiffStats: Bool = true
  ) {
    self.nodes = nodes
    self.depth = depth
    self.collapsedDirs = collapsedDirs
    self.onToggleDir = onToggleDir
    self.onSelectFile = onSelectFile
    self.showDiffStats = showDiffStats
  }

  public var body: some View {
    ForEach(nodes) { node in
      switch node {
      case let .dir(name, path, children):
        dirRow(name: name, path: path, children: children)
      case let .file(name, path, file):
        fileRow(name: name, path: path, file: file)
      }
    }
  }

  @ViewBuilder
  private func dirRow(name: String, path: String, children: [FileTreeNode]) -> some View {
    let collapsed = collapsedDirs.contains(path)
    Button {
      onToggleDir(path)
    } label: {
      HStack(spacing: 6) {
        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
          .font(.caption2)
          .foregroundStyle(TetherColors.textSecondary)
          .frame(width: 12)
        Image(systemName: "folder")
          .font(.caption)
          .foregroundStyle(TetherColors.textSecondary)
        Text(name)
          .font(.system(.subheadline, design: .monospaced))
          .foregroundStyle(TetherColors.textSecondary)
          .lineLimit(1)
        Spacer(minLength: 0)
      }
      .padding(.leading, CGFloat(depth) * 16)
      .padding(.vertical, 8)
      .padding(.trailing, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(collapsed ? "Expand" : "Collapse") folder \(path)")

    if !collapsed {
      FileTreeView(
        nodes: children,
        depth: depth + 1,
        collapsedDirs: collapsedDirs,
        onToggleDir: onToggleDir,
        onSelectFile: onSelectFile,
        showDiffStats: showDiffStats
      )
    }
  }

  private func fileRow(name: String, path: String, file: DiffFileStat) -> some View {
    Button {
      onSelectFile(path)
    } label: {
      HStack(spacing: 8) {
        Text(name)
          .font(.system(.subheadline, design: .monospaced))
          .foregroundStyle(TetherColors.textPrimary)
          .lineLimit(1)
        Spacer(minLength: 8)
        if showDiffStats {
          if file.binary {
            Text("binary")
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(TetherColors.textSecondary)
          } else {
            HStack(spacing: 4) {
              Text("+\(file.insertions)")
                .foregroundStyle(TetherColors.accent)
              Text("-\(file.deletions)")
                .foregroundStyle(TetherColors.danger)
            }
            .font(.system(.caption, design: .monospaced))
          }
        }
      }
      .padding(.leading, CGFloat(depth) * 16 + 20)
      .padding(.vertical, 10)
      .padding(.trailing, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Select \(path)")
  }
}
