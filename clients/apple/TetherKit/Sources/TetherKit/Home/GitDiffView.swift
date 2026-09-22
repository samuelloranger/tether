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
        ToolbarItem(placement: .principal) { if tab == .changes && !controller.gitLines.isEmpty { Text("+\(stat.added)  −\(stat.removed)").font(.caption.weight(.semibold).monospaced()).foregroundStyle(TetherColors.success) } }
        ToolbarItem(placement: .primaryAction) {
          Button { Task { await controller.loadGitWorkspace() } } label: {
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
      ScrollView { DiffReviewView(files: DiffFile.group(controller.gitLines)).padding(.vertical, 6) }
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

  @ViewBuilder private var pullRequests: some View {
    if controller.gitPullRequests.isEmpty {
      if let notice = controller.gitPullRequestNotice {
        ContentUnavailableView("Couldn't load pull requests", systemImage: "exclamationmark.triangle", description: Text(notice))
          .foregroundStyle(TetherColors.textSecondary)
      } else {
        ContentUnavailableView("No open pull requests", systemImage: "arrow.triangle.pull", description: Text("This repository has none open right now."))
          .foregroundStyle(TetherColors.textSecondary)
      }
    } else {
      List(controller.gitPullRequests) { pullRequest in
        NavigationLink { PullRequestDetailView(controller: controller, pullRequest: pullRequest, onShowChanges: { tab = .changes }) } label: {
          VStack(alignment: .leading, spacing: 5) { Text("#\(pullRequest.number) \(pullRequest.title)").lineLimit(2); Text("\(pullRequest.head) → \(pullRequest.base)").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary) }
        }.listRowBackground(TetherColors.surface)
      }.scrollContentBackground(.hidden).background(TetherColors.background)
    }
  }

  private func errorState(_ error: String) -> some View { VStack(spacing: 12) { Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(TetherColors.warning); Text(error).font(.footnote.monospaced()).multilineTextAlignment(.center); Button("Reload") { Task { await controller.loadGitWorkspace() } } }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity) }
}

private struct PullRequestDetailView: View {
  @Bindable var controller: SSHTerminalController
  let pullRequest: GitPullRequest
  var onShowChanges: () -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var confirmClose = false
  @State private var showCopied = false
  @State private var expandDescription = false

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
    .overlay(alignment: .bottom) { copiedPill }
    .task {
      await controller.loadPullRequestDetail(pullRequest)
      // Keep refreshing only while something is still running.
      while !Task.isCancelled, GitRepositoryModel.isRunning(controller.gitChecks) {
        try? await Task.sleep(for: .seconds(Self.pollSeconds))
        guard !Task.isCancelled else { return }
        await controller.loadPullRequestDetail(pullRequest)
      }
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
        Text(GitRepositoryModel.checkHeadline(controller.gitChecks))
          .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
        Spacer(minLength: 4)
        Button {
          Task { await controller.loadPullRequestDetail(pullRequest) }
        } label: {
          if controller.gitChecksLoading {
            ProgressView().controlSize(.small).tint(TetherColors.accent)
          } else {
            Image(systemName: "arrow.clockwise")
          }
        }
        .buttonStyle(.plain).foregroundStyle(TetherColors.accent)
        .accessibilityLabel("Refresh checks")
      }

      ForEach(controller.gitChecks) { check in
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

      if let updated = controller.gitChecksUpdatedAt {
        Text("Updated \(updated, style: .relative) ago")
          .font(.caption2).foregroundStyle(TetherColors.textFaint)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(TetherColors.border))
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
        chipAction("Files", "doc.text.magnifyingglass") {
          Task {
            await controller.loadPullRequestDiff(pullRequest)
            onShowChanges()
            dismiss()
          }
        }
        chipAction("Browser", "safari") {
          if let url = URL(string: pullRequest.url) { UIApplication.shared.open(url) }
        }
        chipAction("Copy link", "doc.on.doc") {
          UIPasteboard.general.string = pullRequest.url
          UIAccessibility.post(notification: .announcement, argument: "Link copied")
          withAnimation { showCopied = true }
          Task {
            try? await Task.sleep(for: .seconds(1.2))
            withAnimation { showCopied = false }
          }
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

  private func chipAction(_ title: String, _ icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 5) {
        Image(systemName: icon).font(.subheadline)
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
    if !controller.gitPullRequestBody.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        sectionTitle("Description")
        MarkdownBodyView(markdown: controller.gitPullRequestBody)
          .frame(maxHeight: expandDescription ? nil : 220, alignment: .top)
          .clipped()
        Button(expandDescription ? "Show less" : "Show more") {
          withAnimation { expandDescription.toggle() }
        }
        .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.accent)
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(TetherColors.border))
    }
  }

  @ViewBuilder
  private var copiedPill: some View {
    if showCopied {
      Label("Link copied", systemImage: "checkmark.circle.fill")
        .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(TetherColors.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(TetherColors.accent.opacity(0.5)))
        .padding(.bottom, 20)
        .transition(.opacity)
    }
  }

  private var rollupIcon: String {
    guard !controller.gitChecks.isEmpty else { return "circle.dashed" }
    if controller.gitChecks.contains(where: { $0.state == .failed }) { return "xmark.circle.fill" }
    if GitRepositoryModel.isRunning(controller.gitChecks) { return "clock.fill" }
    return "checkmark.circle.fill"
  }

  private var rollupTint: Color {
    guard !controller.gitChecks.isEmpty else { return TetherColors.textFaint }
    if controller.gitChecks.contains(where: { $0.state == .failed }) { return TetherColors.danger }
    if GitRepositoryModel.isRunning(controller.gitChecks) { return TetherColors.warning }
    return TetherColors.success
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

}


private struct CommitDetailView: View {
  @Bindable var controller: SSHTerminalController
  let commit: GitCommit

  @State private var lines: [GitDiffLine] = []
  @State private var loading = true

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 6) {
          Text(commit.subject).font(.headline).foregroundStyle(TetherColors.textPrimary)
          Text(commit.id).font(.caption.monospaced()).foregroundStyle(TetherColors.accent)
          Text("\(commit.author) · \(Date(timeIntervalSince1970: TimeInterval(commit.timestamp)).formatted(date: .abbreviated, time: .shortened))")
            .font(.caption).foregroundStyle(TetherColors.textSecondary)
        }
        .padding(.horizontal, 12)

        if loading {
          ProgressView().tint(TetherColors.accent).frame(maxWidth: .infinity).padding(.top, 24)
        } else if lines.isEmpty {
          ContentUnavailableView("No diff for this commit", systemImage: "doc.text",
            description: Text("It may be a merge commit, or the repository is no longer at this path."))
            .foregroundStyle(TetherColors.textSecondary)
        } else {
          DiffReviewView(files: DiffFile.group(lines))
        }
      }
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(TetherColors.background)
    .task {
      lines = await controller.commitDiff(commit)
      loading = false
    }
  }
}

#endif
