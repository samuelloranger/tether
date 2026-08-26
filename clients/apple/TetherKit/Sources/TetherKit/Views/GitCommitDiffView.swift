import SwiftUI

/// Read-only commit patch from `GET /api/sessions/:id/git/commit/:sha/diff`.
public struct GitCommitDiffView: View {
  @Bindable public var store: SessionStore
  public var entry: GitLogEntry

  @State private var lines: [DiffLine] = []
  @State private var truncated = false
  @State private var loading = true
  @State private var loadError: String?
  @State private var sideBySide = false

  public init(store: SessionStore, entry: GitLogEntry) {
    self.store = store
    self.entry = entry
  }

  public var body: some View {
    Group {
      if loading {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .tint(TetherColors.accent)
      } else if let loadError {
        VStack(spacing: 12) {
          Text(loadError)
            .foregroundStyle(TetherColors.textPrimary)
            .multilineTextAlignment(.center)
          Button("Retry") { Task { await load() } }
            .tint(TetherColors.accent)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if lines.isEmpty {
        Text("Empty commit")
          .foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        GeometryReader { proxy in
          ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 0) {
              if truncated {
                Text("[Diff truncated at 1 MiB]")
                  .font(.caption.monospaced())
                  .foregroundStyle(TetherColors.textSecondary)
                  .padding(.horizontal, 12)
                  .padding(.vertical, 6)
              }
              if sideBySide {
                SideBySideDiffView(lines: lines, path: "")
              } else {
                UnifiedDiffBody(
                  lines: lines,
                  path: "",
                  hunkIndices: Array(repeating: nil, count: lines.count),
                  mode: nil,
                  minWidth: proxy.size.width,
                  onToggleHunk: nil
                )
              }
            }
            .frame(minWidth: proxy.size.width, minHeight: proxy.size.height, alignment: .topLeading)
            .padding(.vertical, 8)
          }
        }
      }
    }
    .background(TetherColors.background)
    .navigationTitle(entry.shortSha)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button(sideBySide ? "Unified" : "Side by side") {
          sideBySide.toggle()
        }
        .tint(TetherColors.accent)
      }
    }
    .task { await load() }
  }

  private func load() async {
    loading = true
    loadError = nil
    defer { loading = false }
    guard let response = await store.loadCommitDiff(sha: entry.sha) else {
      loadError = store.errorMessage ?? "Failed to load commit"
      return
    }
    truncated = response.truncated
    lines = visibleDiffLines(parseDiffLines(response.diff))
  }
}
