#if canImport(UIKit)
import SwiftUI
import UIKit

/// Repository workspace scoped to the live cwd of the attached zmx session.
struct GitDiffView: View {
  enum Tab: String, CaseIterable, Identifiable { case changes = "Changes", commits = "Commits", pullRequests = "Pull Requests"; var id: Self { self } }
  @Bindable var controller: SSHTerminalController
  var onDone: () -> Void
  @State private var tab: Tab = .changes
  private var stat: (added: Int, removed: Int) { GitDiffModel.stat(controller.gitLines) }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        HStack(spacing: 9) {
          Image(systemName: "arrow.triangle.branch").foregroundStyle(TetherColors.accent)
          Text(controller.gitBranch.isEmpty ? "Loading repository…" : controller.gitBranch).font(.subheadline.weight(.semibold).monospaced()).lineLimit(1)
          Spacer()
          Text("\(controller.gitPullRequests.count) open").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
        }.padding(.horizontal, 16).padding(.vertical, 12).background(TetherColors.surface)
        Picker("Git section", selection: $tab) { ForEach(Tab.allCases) { Text($0.rawValue).tag($0) } }
          .pickerStyle(.segmented).padding(12)
        Group {
          if controller.gitLoading && controller.gitBranch.isEmpty { ProgressView().tint(TetherColors.accent) }
          else if let error = controller.gitError, controller.gitBranch.isEmpty { errorState(error) }
          else { content }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .background(TetherColors.background).navigationTitle("Git").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done", action: onDone) }
        ToolbarItem(placement: .principal) { if tab == .changes && !controller.gitLines.isEmpty { Text("+\(stat.added)  −\(stat.removed)").font(.caption.weight(.semibold).monospaced()).foregroundStyle(TetherColors.success) } }
        ToolbarItem(placement: .primaryAction) { Button { Task { await controller.loadGitWorkspace() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Refresh Git workspace") }
      }
      .overlay(alignment: .bottom) { if let message = controller.gitActionMessage { Text(message).font(.caption.monospaced()).padding(12).background(TetherColors.surface, in: Capsule()).padding(.bottom, 12) } }
      .task { while !Task.isCancelled { await controller.loadGitWorkspace(); try? await Task.sleep(nanoseconds: 15_000_000_000) } }
    }
  }

  @ViewBuilder private var content: some View {
    switch tab { case .changes: changes; case .commits: commits; case .pullRequests: pullRequests }
  }

  @ViewBuilder private var changes: some View {
    if controller.gitLines.isEmpty {
      ContentUnavailableView("No uncommitted changes", systemImage: "checkmark.circle", description: Text("The current working directory is clean.")).foregroundStyle(TetherColors.textSecondary)
    } else {
      ScrollView { LazyVStack(alignment: .leading, spacing: 0) { ForEach(controller.gitLines) { line in
        Text(line.text.isEmpty ? " " : line.text).font(.caption.monospaced()).foregroundStyle(color(line.kind)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 1).background(background(line.kind))
      }}.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6) }
    }
  }

  private var commits: some View {
    List(controller.gitCommits) { commit in
      NavigationLink { VStack(alignment: .leading, spacing: 12) { Text(commit.subject).font(.headline); Text(commit.id).font(.caption.monospaced()).foregroundStyle(TetherColors.accent); Text("\(commit.author) · \(Date(timeIntervalSince1970: TimeInterval(commit.timestamp)).formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(TetherColors.textSecondary) }.padding().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(TetherColors.background) } label: {
        VStack(alignment: .leading, spacing: 4) { Text(commit.subject).lineLimit(2); Text("\(commit.id) · \(commit.author)").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary) }
      }.listRowBackground(TetherColors.surface)
    }.scrollContentBackground(.hidden).background(TetherColors.background)
  }

  @ViewBuilder private var pullRequests: some View {
    if controller.gitPullRequests.isEmpty {
      ContentUnavailableView("No open pull requests", systemImage: "arrow.triangle.pull", description: Text("Install and authenticate GitHub CLI on the host to load pull requests.")).foregroundStyle(TetherColors.textSecondary)
    } else {
      List(controller.gitPullRequests) { pullRequest in
        NavigationLink { PullRequestDetailView(controller: controller, pullRequest: pullRequest, onShowChanges: { tab = .changes }) } label: {
          VStack(alignment: .leading, spacing: 5) { Text("#\(pullRequest.number) \(pullRequest.title)").lineLimit(2); Text("\(pullRequest.head) → \(pullRequest.base)").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary) }
        }.listRowBackground(TetherColors.surface)
      }.scrollContentBackground(.hidden).background(TetherColors.background)
    }
  }

  private func errorState(_ error: String) -> some View { VStack(spacing: 12) { Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(TetherColors.warning); Text(error).font(.footnote.monospaced()).multilineTextAlignment(.center); Button("Reload") { Task { await controller.loadGitWorkspace() } } }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity) }
  private func color(_ kind: GitDiffLineKind) -> Color { switch kind { case .added: TetherColors.success; case .removed: TetherColors.danger; case .hunk: TetherColors.accent; case .fileHeader: TetherColors.textSecondary; case .context: TetherColors.textPrimary } }
  private func background(_ kind: GitDiffLineKind) -> Color { switch kind { case .added: TetherColors.success.opacity(0.08); case .removed: TetherColors.danger.opacity(0.08); case .hunk: TetherColors.accent.opacity(0.06); default: .clear } }
}

private struct PullRequestDetailView: View {
  @Bindable var controller: SSHTerminalController
  let pullRequest: GitPullRequest
  var onShowChanges: () -> Void
  @State private var confirmClose = false
  var body: some View {
    ScrollView { VStack(alignment: .leading, spacing: 16) {
      Text("#\(pullRequest.number) \(pullRequest.title)").font(.title3.weight(.bold))
      Text("\(pullRequest.head) → \(pullRequest.base)").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
      HStack(spacing: 8) { chip("\(pullRequest.changedFiles) files"); chip(pullRequest.isDraft ? "Draft" : "Open"); if let decision = pullRequest.reviewDecision { chip(decision.replacingOccurrences(of: "_", with: " ")) } }
      section("Review") { action("Checkout branch", "arrow.down.to.line") { Task { await controller.checkoutPullRequest(pullRequest) } }; action("View changed files", "doc.text.magnifyingglass") { onShowChanges() }; action("Open in browser", "safari") { if let url = URL(string: pullRequest.url) { UIApplication.shared.open(url) } }; action("Copy link", "doc.on.doc") { UIPasteboard.general.string = pullRequest.url } }
      section("Repository actions") { action("Update branch", "arrow.clockwise") { Task { await controller.updatePullRequest(pullRequest) } }; Button(role: .destructive) { confirmClose = true } label: { Label("Close pull request", systemImage: "xmark.circle") } }
      Text("Merge remains browser-only. Closing a pull request requires confirmation.").font(.caption).foregroundStyle(TetherColors.textSecondary)
    }.padding() }.background(TetherColors.background)
    .confirmationDialog("Close pull request #\(pullRequest.number)?", isPresented: $confirmClose, titleVisibility: .visible) { Button("Close pull request", role: .destructive) { Task { await controller.closePullRequest(pullRequest) } } }
  }
  private func chip(_ text: String) -> some View { Text(text).font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary).padding(.horizontal, 8).padding(.vertical, 5).background(TetherColors.surface, in: Capsule()) }
  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View { VStack(alignment: .leading, spacing: 8) { Text(title).font(.caption.weight(.bold)).foregroundStyle(TetherColors.textSecondary); content() } }
  private func action(_ title: String, _ icon: String, action: @escaping () -> Void) -> some View { Button(action: action) { Label(title, systemImage: icon).frame(maxWidth: .infinity, alignment: .leading) }.buttonStyle(.bordered).tint(TetherColors.accent) }
}
#endif
