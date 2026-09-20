#if canImport(UIKit)
import SwiftUI

/// Read-only `git diff` for the current session's working directory, fetched over
/// SSH exec and colored client-side. Repoints the v5 git feature off the old
/// Noise server onto plain exec.
struct GitDiffView: View {
  @Bindable var controller: SSHTerminalController
  var onDone: () -> Void

  private var stat: (added: Int, removed: Int) { GitDiffModel.stat(controller.gitLines) }

  public var body: some View {
    NavigationStack {
      Group {
        if controller.gitLoading && controller.gitLines.isEmpty {
          ProgressView().tint(TetherColors.accent).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = controller.gitError, controller.gitLines.isEmpty {
          VStack(spacing: 8) {
            Image(systemName: "checkmark.circle").font(.system(size: 26)).foregroundStyle(TetherColors.textFaint)
            Text(error).font(.system(size: 13, design: .monospaced))
              .foregroundStyle(TetherColors.textSecondary).multilineTextAlignment(.center)
          }
          .padding(30).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(controller.gitLines) { line in
                Text(line.text.isEmpty ? " " : line.text)
                  .font(.system(size: 11.5, design: .monospaced))
                  .foregroundStyle(color(line.kind))
                  .textSelection(.enabled)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(.horizontal, 12).padding(.vertical, 1)
                  .background(background(line.kind))
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
      }
      .background(TetherColors.background)
      .navigationTitle("git diff")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done", action: onDone) }
        ToolbarItem(placement: .principal) {
          if !controller.gitLines.isEmpty {
            HStack(spacing: 8) {
              Text("+\(stat.added)").foregroundStyle(TetherColors.success)
              Text("−\(stat.removed)").foregroundStyle(TetherColors.danger)
            }
            .font(.system(size: 12, weight: .semibold, design: .monospaced))
          }
        }
      }
      .task { await controller.loadGitDiff() }
    }
  }

  private func color(_ kind: GitDiffLineKind) -> Color {
    switch kind {
    case .added: return TetherColors.success
    case .removed: return TetherColors.danger
    case .hunk: return TetherColors.accent
    case .fileHeader: return TetherColors.textSecondary
    case .context: return TetherColors.textPrimary
    }
  }

  private func background(_ kind: GitDiffLineKind) -> Color {
    switch kind {
    case .added: return TetherColors.success.opacity(0.08)
    case .removed: return TetherColors.danger.opacity(0.08)
    case .hunk: return TetherColors.accent.opacity(0.06)
    default: return .clear
    }
  }
}
#endif
