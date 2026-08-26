import SwiftUI

public struct GitDrawerView: View {
  @Bindable public var store: SessionStore
  public var onDismiss: () -> Void

  @State private var tab: GitTabBar.Tab = .changes
  @State private var summary = DiffSummary()
  @State private var historyEntries: [GitLogEntry]?
  @State private var commitMessage = ""
  @State private var loading = true
  @State private var committing = false
  @State private var path = NavigationPath()
  /// Discard / undo / push all need a confirm — irreversible or disruptive.
  @State private var pendingConfirm: PendingConfirm?

  private enum PendingConfirm: Identifiable {
    case discardAll
    case discardFile(String)
    case undoCommit
    case push

    var id: String {
      switch self {
      case .discardAll: "discard-all"
      case let .discardFile(path): "discard:\(path)"
      case .undoCommit: "undo"
      case .push: "push"
      }
    }

    var title: String {
      switch self {
      case .discardAll: "Discard all changes?"
      case let .discardFile(path): "Discard changes to \(path)?"
      case .undoCommit: "Undo last commit?"
      case .push: "Push current branch?"
      }
    }

    var message: String {
      switch self {
      case .discardAll, .discardFile:
        "This cannot be undone."
      case .undoCommit:
        "HEAD will move back one commit. Changes stay staged."
      case .push:
        "Pushes the current branch to its upstream (or origin/HEAD)."
      }
    }

    var confirmLabel: String {
      switch self {
      case .discardAll, .discardFile: "Discard"
      case .undoCommit: "Undo commit"
      case .push: "Push"
      }
    }

    var isDestructive: Bool {
      switch self {
      case .discardAll, .discardFile, .undoCommit: true
      case .push: false
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
        GitTabBar(tab: $tab)
          .onChange(of: tab) { _, newTab in
            if newTab == .history {
              Task { await loadHistory() }
            }
          }
        Group {
          switch tab {
          case .changes:
            changesBody
          case .history:
            GitHistoryListView(entries: historyEntries) { entry in
              path.append(GitNavRoute.commit(entry))
            }
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        if tab == .changes {
          commitBar
        }
      }
      .background(TetherColors.background)
      .navigationDestination(for: GitNavRoute.self) { route in
        switch route {
        case let .review(review):
          GitReviewView(
            store: store,
            path: review.path,
            mode: review.mode,
            binary: review.binary,
            onChanged: { Task { await reload() } }
          )
        case let .commit(entry):
          GitCommitDiffView(store: store, entry: entry)
        }
      }
    }
    .task { await reload() }
    .confirmationDialog(
      pendingConfirm?.title ?? "",
      isPresented: Binding(
        get: { pendingConfirm != nil },
        set: { if !$0 { pendingConfirm = nil } }
      ),
      titleVisibility: .visible,
      presenting: pendingConfirm
    ) { target in
      Button(
        target.confirmLabel,
        role: target.isDestructive ? .destructive : nil
      ) {
        Task { await performConfirm(target) }
      }
      Button("Cancel", role: .cancel) {}
    } message: { target in
      Text(target.message)
    }
  }

  private var changesBody: some View {
    Group {
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
    }
  }

  private var header: some View {
    HStack {
      Text("Git")
        .font(.headline)
        .foregroundStyle(TetherColors.textPrimary)
      Spacer()
      if tab == .changes, let label = changeLabel(summary) {
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
                pendingConfirm = .discardAll
              }
            }
          }
        }
      }
    }
    .listStyle(.plain)
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
      path.append(
        GitNavRoute.review(
          GitReviewRoute(path: file.path, mode: mode, binary: file.binary)
        )
      )
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
          pendingConfirm = .discardFile(file.path)
        }
      }
    }
  }

  private var commitBar: some View {
    HStack(alignment: .bottom, spacing: 10) {
      TextField("Commit message", text: $commitMessage, axis: .vertical)
        .lineLimit(1...4)
        .textFieldStyle(.plain)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(10)
        .background(TetherColors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .foregroundStyle(TetherColors.textPrimary)

      Menu {
        Button("Undo last commit", role: .destructive) {
          pendingConfirm = .undoCommit
        }
        Button("Push") {
          pendingConfirm = .push
        }
      } label: {
        Image(systemName: "ellipsis.circle")
          .font(.title3)
          .foregroundStyle(TetherColors.accent)
          .frame(width: 36, height: 36)
      }
      .accessibilityLabel("More git actions")

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

  private func loadHistory() async {
    historyEntries = await store.loadGitLog() ?? []
  }

  private func submitCommit() async {
    let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty else { return }
    committing = true
    defer { committing = false }
    if await store.gitCommit(message: message) {
      commitMessage = ""
      await reload()
      // History is stale after a commit.
      if historyEntries != nil {
        historyEntries = nil
      }
    }
  }

  private func performConfirm(_ target: PendingConfirm) async {
    switch target {
    case .discardAll:
      await store.gitDiscardAll()
      await reload()
    case let .discardFile(path):
      await store.gitDiscard(path: path)
      await reload()
    case .undoCommit:
      if await store.gitUndoLastCommit() {
        await reload()
        historyEntries = nil
      }
    case .push:
      _ = await store.gitPushBranch()
    }
  }
}

enum GitNavRoute: Hashable {
  case review(GitReviewRoute)
  case commit(GitLogEntry)
}

struct GitReviewRoute: Hashable {
  var path: String
  var mode: GitDiffMode
  var binary: Bool
}
