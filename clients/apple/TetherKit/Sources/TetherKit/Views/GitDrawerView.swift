import SwiftUI

public struct GitDrawerView: View {
  @Bindable public var store: SessionStore
  public var onDismiss: () -> Void

  @State private var summary = DiffSummary()
  @State private var commitMessage = ""
  @State private var loading = true
  @State private var committing = false
  @State private var path = NavigationPath()
  /// Set to the discard the user is about to confirm. Discarding throws work
  /// away irreversibly, so — like killing a session — it asks first.
  @State private var pendingDiscard: PendingDiscard?

  private enum PendingDiscard: Identifiable {
    case all
    case file(String)

    var id: String {
      switch self {
      case .all: "all"
      case let .file(path): "file:\(path)"
      }
    }

    var title: String {
      switch self {
      case .all: "Discard all changes?"
      case let .file(path): "Discard changes to \(path)?"
      }
    }
  }

  public init(store: SessionStore, onDismiss: @escaping () -> Void) {
    self.store = store
    self.onDismiss = onDismiss
  }

  private var groups: DiffSummaryGroups { groupSummary(summary) }

  public var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        header
        if loading {
          ProgressView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .tint(TetherColors.accent)
        } else if summary.files.isEmpty {
          Text("No uncommitted changes")
            .foregroundStyle(TetherColors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          fileList
        }
        commitBar
      }
      .background(TetherColors.background)
      .navigationDestination(for: GitReviewRoute.self) { route in
        GitReviewView(
          store: store,
          path: route.path,
          mode: route.mode,
          onChanged: { Task { await reload() } }
        )
      }
    }
    .task { await reload() }
  }

  private var header: some View {
    HStack {
      Text("Working tree")
        .font(.headline)
        .foregroundStyle(TetherColors.textPrimary)
      Spacer()
      if let label = changeLabel(summary) {
        Text(label)
          .font(.caption.monospaced())
          .foregroundStyle(TetherColors.textSecondary)
      }
      Button(action: onDismiss) {
        Image(systemName: "xmark")
          .frame(width: 32, height: 32)
      }
      .accessibilityLabel("Close git")
    }
    .buttonStyle(.plain)
    .foregroundStyle(TetherColors.textPrimary)
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(TetherColors.surface)
  }

  private var fileList: some View {
    List {
      if !groups.staged.isEmpty {
        Section {
          ForEach(groups.staged) { file in
            fileRow(file, mode: .staged)
          }
        } header: {
          sectionHeader("Staged", count: groups.staged.count) {
            Button("Unstage all") {
              Task {
                await store.gitUnstageAll()
                await reload()
              }
            }
          }
        }
      }

      if !groups.unstaged.isEmpty {
        Section {
          ForEach(groups.unstaged) { file in
            fileRow(file, mode: .unstaged)
          }
        } header: {
          sectionHeader("Changes", count: groups.unstaged.count) {
            HStack(spacing: 12) {
              Button("Stage all") {
                Task {
                  await store.gitStageAll()
                  await reload()
                }
              }
              Button("Discard all", role: .destructive) {
                pendingDiscard = .all
              }
            }
          }
        }
      }
    }
    .listStyle(.plain)
    .confirmationDialog(
      pendingDiscard?.title ?? "",
      isPresented: Binding(
        get: { pendingDiscard != nil },
        set: { if !$0 { pendingDiscard = nil } }
      ),
      titleVisibility: .visible,
      presenting: pendingDiscard
    ) { target in
      Button("Discard", role: .destructive) {
        Task {
          switch target {
          case .all:
            await store.gitDiscardAll()
          case let .file(path):
            await store.gitDiscard(path: path)
          }
          await reload()
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      Text("This cannot be undone.")
    }
    .scrollContentBackground(.hidden)
    .background(TetherColors.background)
  }

  private func sectionHeader(
    _ title: String,
    count: Int,
    @ViewBuilder actions: () -> some View
  ) -> some View {
    HStack {
      Text("\(title) · \(count)")
        .font(.caption.weight(.semibold))
        .foregroundStyle(TetherColors.textSecondary)
        .textCase(nil)
      Spacer()
      actions()
        .font(.caption)
        .tint(TetherColors.accent)
    }
  }

  private func fileRow(_ file: DiffFileStat, mode: GitDiffMode) -> some View {
    Button {
      path.append(GitReviewRoute(path: file.path, mode: mode))
    } label: {
      HStack(spacing: 10) {
        Text(file.statusLetter)
          .font(.caption.monospaced().weight(.bold))
          .foregroundStyle(letterColor(file.statusLetter))
          .frame(width: 16)

        Text(file.path)
          .font(.subheadline.monospaced())
          .foregroundStyle(TetherColors.textPrimary)
          .lineLimit(1)

        Spacer(minLength: 8)

        if file.binary {
          Text("binary")
            .font(.caption)
            .foregroundStyle(TetherColors.textSecondary)
        } else {
          HStack(spacing: 4) {
            Text("+\(file.insertions)")
              .foregroundStyle(Color.green.opacity(0.9))
            Text("-\(file.deletions)")
              .foregroundStyle(TetherColors.danger)
          }
          .font(.caption.monospaced())
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .listRowBackground(TetherColors.background)
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      if mode == .staged {
        Button("Unstage") {
          Task {
            await store.gitUnstage(path: file.path)
            await reload()
          }
        }
        .tint(TetherColors.accent)
      } else {
        Button("Stage") {
          Task {
            await store.gitStage(path: file.path)
            await reload()
          }
        }
        .tint(TetherColors.accent)
        Button("Discard", role: .destructive) {
          pendingDiscard = .file(file.path)
        }
      }
    }
  }

  private var commitBar: some View {
    HStack(alignment: .bottom, spacing: 10) {
      TextField("Commit message", text: $commitMessage, axis: .vertical)
        .lineLimit(1...4)
        .textFieldStyle(.plain)
        .padding(10)
        .background(TetherColors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .foregroundStyle(TetherColors.textPrimary)

      Button {
        Task { await submitCommit() }
      } label: {
        if committing {
          ProgressView()
            .controlSize(.small)
        } else {
          Text("Commit")
            .fontWeight(.semibold)
        }
      }
      .buttonStyle(.borderedProminent)
      .tint(TetherColors.accent)
      .disabled(!canCommit)
    }
    .padding(16)
    .background(TetherColors.surface)
  }

  private var canCommit: Bool {
    !committing
      && !commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !groups.staged.isEmpty
  }

  private func letterColor(_ letter: String) -> Color {
    switch letter {
    case "A": Color.green.opacity(0.9)
    case "D": TetherColors.danger
    case "B": TetherColors.textSecondary
    default: TetherColors.accent
    }
  }

  private func reload() async {
    loading = summary.files.isEmpty
    if let next = await store.loadDiffSummary() {
      summary = next
    }
    loading = false
  }

  private func submitCommit() async {
    let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty else { return }
    committing = true
    defer { committing = false }
    if await store.gitCommit(message: message) {
      commitMessage = ""
      await reload()
    }
  }
}

struct GitReviewRoute: Hashable {
  var path: String
  var mode: GitDiffMode
}
