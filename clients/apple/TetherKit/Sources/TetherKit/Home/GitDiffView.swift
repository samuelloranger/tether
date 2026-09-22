#if canImport(UIKit)
import SwiftUI
import UIKit

/// Repository workspace scoped to the live cwd of the attached zmx session.
struct GitDiffView: View {
  enum Tab: String, CaseIterable, Identifiable { case changes = "Changes", commits = "Commits", pullRequests = "Pull Requests"; var id: Self { self } }
  @Bindable var controller: SSHTerminalController
  var onDone: () -> Void
  @Environment(\.scenePhase) private var scenePhase
  @State private var tab: Tab = .changes
  private var stat: (added: Int, removed: Int) { DiffFile.stat(controller.gitFiles) }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        HStack(spacing: 9) {
          Image(systemName: "arrow.triangle.branch").foregroundStyle(TetherColors.accent)
          Text(controller.gitBranch.isEmpty ? "Loading repository…" : controller.gitBranch).font(.subheadline.weight(.semibold).monospaced()).lineLimit(1)
          Spacer()
          VStack(alignment: .trailing, spacing: 1) {
            Text("\(controller.gitPullRequests.count) open").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
            // Without this a refresh that changed nothing looks like a refresh
            // that did nothing.
            if let updated = controller.gitUpdatedAt {
              Text("updated \(updated, style: .relative) ago").font(.caption2).foregroundStyle(TetherColors.textFaint)
            }
          }
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
        ToolbarItem(placement: .principal) { if tab == .changes && !controller.gitFiles.isEmpty { Text("+\(stat.added)  −\(stat.removed)").font(.caption.weight(.semibold).monospaced()).foregroundStyle(TetherColors.success) } }
        ToolbarItem(placement: .primaryAction) {
          Button { Task { await refreshVisiblePayload() } } label: {
            if controller.gitLoading {
              ProgressView().controlSize(.small).tint(TetherColors.accent)
            } else {
              Image(systemName: "arrow.clockwise")
            }
          }
          .disabled(controller.gitLoading)
          .accessibilityLabel("Refresh Git workspace")
        }
      }
      .overlay(alignment: .bottom) { if let message = controller.gitActionMessage { Text(message).font(.caption.monospaced()).padding(12).background(TetherColors.surface, in: Capsule()).padding(.bottom, 12) } }
      .task(id: "\(tab.rawValue)-\(scenePhase == .active)") {
        while !Task.isCancelled, scenePhase == .active {
          await refreshVisiblePayload()
          try? await Task.sleep(nanoseconds: tab == .pullRequests ? 60_000_000_000 : 15_000_000_000)
        }
      }
    }
  }

  @ViewBuilder private var content: some View {
    switch tab { case .changes: changes; case .commits: commits; case .pullRequests: pullRequests }
  }

  @ViewBuilder private var changes: some View {
    if controller.gitFiles.isEmpty {
      ContentUnavailableView("No uncommitted changes", systemImage: "checkmark.circle", description: Text("The current working directory is clean.")).foregroundStyle(TetherColors.textSecondary)
    } else {
      ScrollView { DiffReviewView(files: controller.gitFiles).padding(.vertical, 6) }
    }
  }

  private var commits: some View {
    List(controller.gitCommits) { commit in
      NavigationLink { CommitDetailView(controller: controller, commit: commit) } label: {
        VStack(alignment: .leading, spacing: 4) {
          Text(commit.subject).lineLimit(2)
          Text("\(commit.id) · \(commit.author)").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
        }
      }.listRowBackground(TetherColors.surface)
    }.scrollContentBackground(.hidden).background(TetherColors.background)
  }

  private var pullRequests: some View {
    List {
      if controller.gitPullRequests.isEmpty {
        if let notice = controller.gitPullRequestNotice {
          ContentUnavailableView("Couldn't load pull requests", systemImage: "exclamationmark.triangle", description: Text(notice))
            .foregroundStyle(TetherColors.textSecondary)
        } else {
          ContentUnavailableView("No open pull requests", systemImage: "arrow.triangle.pull", description: Text("This repository has none open right now."))
            .foregroundStyle(TetherColors.textSecondary)
        }
      } else {
        ForEach(controller.gitPullRequests) { pullRequest in
        NavigationLink { PullRequestDetailView(controller: controller, pullRequest: pullRequest) } label: {
          VStack(alignment: .leading, spacing: 5) { Text("#\(pullRequest.number) \(pullRequest.title)").lineLimit(2); Text("\(pullRequest.head) → \(pullRequest.base)").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary) }
        }.listRowBackground(TetherColors.surface)
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(TetherColors.background)
    .refreshable { await refreshVisiblePayload() }
  }

  private var workspacePayload: SSHTerminalController.GitWorkspacePayload {
    switch tab {
    case .changes: .changes
    case .commits: .commits
    case .pullRequests: .pullRequests
    }
  }

  private func refreshVisiblePayload() async {
    await controller.loadGitWorkspace(payload: workspacePayload)
  }

  private func errorState(_ error: String) -> some View { VStack(spacing: 12) { Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(TetherColors.warning); Text(error).font(.footnote.monospaced()).multilineTextAlignment(.center); Button("Reload") { Task { await refreshVisiblePayload() } } }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity) }
}

private struct PullRequestDetailView: View {
  @Bindable var controller: SSHTerminalController
  let pullRequest: GitPullRequest
  @State private var detail = PullRequestDetail.empty
  @State private var loadingDetail = false
  @State private var confirmClose = false
  @State private var showCopied = false
  @State private var diffFiles: [DiffFile] = []
  @State private var blocks: [MarkdownBlock] = []
  @State private var inlineBlocks: [[AttributedString]] = []
  @State private var loadingDiff = false
  @State private var showDiff = false

  private static let pollSeconds: UInt64 = 10

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header
        checks
        actions
        description
      }
      .padding()
    }
    .background(TetherColors.background)
    .copyConfirmation(isPresented: $showCopied)
    .sheet(isPresented: $showDiff) {
      PatchSheet(title: "#\(pullRequest.number)", subtitle: pullRequest.title, files: diffFiles)
    }
    .task {
      refreshDescription(detail.body)
      await refreshDetail()
      // Keep refreshing only while something is still running.
      while !Task.isCancelled, GitRepositoryModel.isRunning(detail.checks) {
        try? await Task.sleep(for: .seconds(Self.pollSeconds))
        guard !Task.isCancelled else { return }
        await refreshDetail()
      }
    }
    .onChange(of: detail.body) { _, body in
      refreshDescription(body)
    }
    .confirmationDialog("Close pull request #\(pullRequest.number)?", isPresented: $confirmClose, titleVisibility: .visible) {
      Button("Close pull request", role: .destructive) { Task { await controller.closePullRequest(pullRequest) } }
      Button("Cancel", role: .cancel) {}
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("#\(pullRequest.number) \(pullRequest.title)").font(.title3.weight(.bold))
        .foregroundStyle(TetherColors.textPrimary)
      Text("\(pullRequest.head) → \(pullRequest.base)").font(.caption.monospaced())
        .foregroundStyle(TetherColors.textSecondary).lineLimit(1).truncationMode(.middle)
      HStack(spacing: 6) {
        chip(pullRequest.isDraft ? "Draft" : "Open", tint: pullRequest.isDraft ? TetherColors.textSecondary : TetherColors.success)
        chip("\(pullRequest.changedFiles) files", tint: TetherColors.textSecondary)
        if let decision = pullRequest.reviewDecision, !decision.isEmpty {
          chip(decision.replacingOccurrences(of: "_", with: " ").lowercased(), tint: TetherColors.accent)
        }
      }
    }
  }

  private var checks: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: rollupIcon).foregroundStyle(rollupTint)
        Text(GitRepositoryModel.checkHeadline(detail.checks))
          .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
        Spacer(minLength: 4)
        Button {
          Task { await refreshDetail() }
        } label: {
          if loadingDetail {
            ProgressView().controlSize(.small).tint(TetherColors.accent)
          } else {
            Image(systemName: "arrow.clockwise")
          }
        }
        .buttonStyle(.plain).foregroundStyle(TetherColors.accent)
        .accessibilityLabel("Refresh checks")
      }

      ForEach(detail.checks) { check in
        Button {
          if let url = URL(string: check.url), !check.url.isEmpty { UIApplication.shared.open(url) }
        } label: {
          HStack(spacing: 9) {
            Image(systemName: icon(for: check.state)).foregroundStyle(tint(for: check.state))
              .font(.caption)
            Text(check.name).font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
            Spacer(minLength: 0)
            if !check.url.isEmpty {
              Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(TetherColors.textFaint)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }

      if detail.fetchedAt != .distantPast {
        Text("Updated \(detail.fetchedAt, style: .relative) ago")
          .font(.caption2).foregroundStyle(TetherColors.textFaint)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .tetherCard()
  }

  private var actions: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button {
        Task { await controller.checkoutPullRequest(pullRequest) }
      } label: {
        Label("Checkout branch", systemImage: "arrow.down.to.line")
          .font(.subheadline.weight(.semibold))
          .padding(.horizontal, 16).padding(.vertical, 11)
      }
      .background(TetherColors.accent, in: Capsule())
      .foregroundStyle(TetherColors.onAccent)
      .buttonStyle(TetherPressStyle())

      HStack(spacing: 8) {
        chipAction("Files", "doc.text.magnifyingglass", loading: loadingDiff) {
          guard !loadingDiff else { return }
          loadingDiff = true
          Task {
            diffFiles = DiffFile.group(await controller.pullRequestDiff(pullRequest))
            loadingDiff = false
            showDiff = true
          }
        }
        chipAction("Browser", "safari") {
          if let url = URL(string: pullRequest.url) { UIApplication.shared.open(url) }
        }
        chipAction("Copy link", "doc.on.doc") {
          acknowledgeCopy(pullRequest.url, announce: "Link copied", into: $showCopied)
        }
      }

      HStack(spacing: 14) {
        Button("Update branch") { Task { await controller.updatePullRequest(pullRequest) } }
          .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.accent)
        Button("Close pull request") { confirmClose = true }
          .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.danger)
        Spacer(minLength: 0)
      }
      .padding(.top, 2)

      Text("Merging stays in the browser.").font(.caption2).foregroundStyle(TetherColors.textFaint)
    }
  }

  private func chipAction(_ title: String, _ icon: String, loading: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 5) {
        if loading {
          ProgressView().controlSize(.small).tint(TetherColors.accent).frame(height: 18)
        } else {
          Image(systemName: icon).font(.subheadline).frame(height: 18)
        }
        Text(title).font(.caption2)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 11)
      .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 11))
      .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
    }
    .buttonStyle(TetherPressStyle())
    .foregroundStyle(TetherColors.accent)
  }

  @ViewBuilder
  private var description: some View {
    if !blocks.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        sectionTitle("Description")
        MarkdownBodyView(blocks: blocks, inlineBlocks: inlineBlocks)
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .tetherCard()
    }
  }


  private var rollupIcon: String {
    GitRepositoryModel.rollup(detail.checks).map(icon(for:)) ?? "circle.dashed"
  }

  private var rollupTint: Color {
    GitRepositoryModel.rollup(detail.checks).map(tint(for:)) ?? TetherColors.textFaint
  }

  private func icon(for state: GitCheck.State) -> String {
    switch state {
    case .passed: "checkmark.circle.fill"
    case .failed: "xmark.circle.fill"
    case .running: "clock.fill"
    case .skipped: "minus.circle"
    }
  }

  private func tint(for state: GitCheck.State) -> Color {
    switch state {
    case .passed: TetherColors.success
    case .failed: TetherColors.danger
    case .running: TetherColors.warning
    case .skipped: TetherColors.textFaint
    }
  }

  private func chip(_ text: String, tint: Color) -> some View {
    Text(text).font(.caption2.weight(.semibold).monospaced()).foregroundStyle(tint)
      .padding(.horizontal, 8).padding(.vertical, 4)
      .background(tint.opacity(0.12), in: Capsule())
  }

  private func sectionTitle(_ title: String) -> some View {
    Text(title).font(.caption.weight(.bold)).foregroundStyle(TetherColors.textSecondary)
  }

  private func refreshDetail() async {
    guard !loadingDetail else { return }
    loadingDetail = true
    defer { loadingDetail = false }
    let fetched = await controller.loadPullRequestDetail(pullRequest)
    guard !Task.isCancelled, fetched.fetchedAt != .distantPast else { return }
    detail = fetched
  }

  private func refreshDescription(_ body: String) {
    let parsed = MarkdownDocument.parse(body)
    blocks = parsed
    inlineBlocks = MarkdownBodyView.renderedInline(for: parsed)
  }

}


private struct CommitDetailView: View {
  @Bindable var controller: SSHTerminalController
  let commit: GitCommit

  @State private var lines: [GitDiffLine] = []
  @State private var files: [DiffFile] = []
  @State private var message = ""
  @State private var loading = true

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 6) {
          Text(commit.subject).font(.headline).foregroundStyle(TetherColors.textPrimary)
          Text(commit.id).font(.caption.monospaced()).foregroundStyle(TetherColors.accent)
          Text("\(commit.author) · \(Date(timeIntervalSince1970: TimeInterval(commit.timestamp)).formatted(date: .abbreviated, time: .shortened))")
            .font(.caption).foregroundStyle(TetherColors.textSecondary)
          if !message.isEmpty {
            Text(message).font(.callout).foregroundStyle(TetherColors.textSecondary)
              .textSelection(.enabled).padding(.top, 4)
          }
        }
        .padding(.horizontal, 12)

        if loading {
          ProgressView().tint(TetherColors.accent).frame(maxWidth: .infinity).padding(.top, 24)
        } else if lines.isEmpty {
          ContentUnavailableView("No diff for this commit", systemImage: "doc.text",
            description: Text("It may be a merge commit, or the repository is no longer at this path."))
            .foregroundStyle(TetherColors.textSecondary)
        } else {
          DiffReviewView(files: files)
        }
      }
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(TetherColors.background)
    .task {
      let shown = await controller.commitDiff(commit)
      message = shown.body
      lines = shown.lines
      files = DiffFile.group(shown.lines)
      loading = false
    }
  }
}

/// A patch shown over whatever opened it, so closing it returns you there.
private struct PatchSheet: View {
  let title: String
  let subtitle: String
  let files: [DiffFile]

  @Environment(\.dismiss) private var dismiss

  private var stat: (added: Int, removed: Int) { DiffFile.stat(files) }

  var body: some View {
    NavigationStack {
      Group {
        if files.isEmpty {
          ContentUnavailableView("No changes to show", systemImage: "doc.text",
            description: Text("This pull request has no diff against its base."))
            .foregroundStyle(TetherColors.textSecondary)
        } else {
          ScrollView { DiffReviewView(files: files).padding(.vertical, 6) }
        }
      }
      .background(TetherColors.background)
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .principal) {
          VStack(spacing: 1) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
            Text("+\(stat.added)  −\(stat.removed)").font(.caption2.monospaced())
              .foregroundStyle(TetherColors.textSecondary)
          }
        }
      }
    }
  }
}

#endif
