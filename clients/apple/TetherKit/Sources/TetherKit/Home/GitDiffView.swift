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
          Text("\(controller.gitPullRequests.filter { $0.state == .open }.count) open").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
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
        if !controller.gitPullRequestsLoaded {
          HStack { Spacer(); ProgressView().tint(TetherColors.accent); Spacer() }
            .padding(.vertical, 40).listRowBackground(Color.clear)
        } else if let notice = controller.gitPullRequestNotice {
          ContentUnavailableView("Couldn't load pull requests", systemImage: "exclamationmark.triangle", description: Text(notice))
            .foregroundStyle(TetherColors.textSecondary)
        } else {
          ContentUnavailableView("No open pull requests", systemImage: "arrow.triangle.pull", description: Text("This repository has none open right now."))
            .foregroundStyle(TetherColors.textSecondary)
        }
      } else {
        ForEach(controller.gitPullRequests) { pullRequest in
        NavigationLink { PullRequestDetailView(controller: controller, pullRequest: pullRequest) } label: {
          VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
              Text("#\(pullRequest.number) \(pullRequest.title)").lineLimit(2)
              Spacer(minLength: 4)
              prStateBadge(pullRequest.state)
            }
            Text("\(pullRequest.head) → \(pullRequest.base)").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
          }
        }.listRowBackground(TetherColors.surface)
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(TetherColors.background)
    .refreshable { await refreshVisiblePayload() }
  }

  @ViewBuilder
  private func prStateBadge(_ state: PRState) -> some View {
    switch state {
    case .open:
      badgeLabel("Open", tint: TetherColors.success)
    case .merged:
      badgeLabel("Merged", tint: TetherColors.accent)
    case .closed:
      badgeLabel("Closed", tint: TetherColors.textFaint)
    }
  }

  private func badgeLabel(_ text: String, tint: Color) -> some View {
    Text(text.uppercased())
      .font(.caption2.weight(.bold))
      .foregroundStyle(tint)
      .padding(.horizontal, 7).padding(.vertical, 3)
      .background(tint.opacity(0.15), in: Capsule())
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
  @State private var confirmMerge = false
  @State private var merging = false
  @State private var showCopied = false
  @State private var diffFiles: [DiffFile] = []
  @State private var blocks: [MarkdownBlock] = []
  @State private var inlineBlocks: [[AttributedString]] = []
  @State private var loadingDiff = false
  @State private var showDiff = false


  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header
        checks
        mergeCard
        reviewChanges
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
      // Prefer waiting on the host — gh's own watch blocks until the run
      // settles — but always converge: refetch after every attempt, and if the
      // watch did not genuinely wait (its dial failed, or it returned at once
      // because gh and the rollup disagree), fall back to a timed poll rather
      // than giving up and leaving the checks stuck "running".
      while !Task.isCancelled, GitRepositoryModel.isRunning(detail.checks) {
        let start = Date()
        let watched = await controller.awaitChecksSettled(pullRequest)
        guard !Task.isCancelled else { break }
        if !watched || Date().timeIntervalSince(start) < 2 {
          try? await Task.sleep(for: .seconds(10))
          guard !Task.isCancelled else { break }
        }
        await refreshDetail()
      }
    }
    .onChange(of: detail.body) { _, body in
      refreshDescription(body)
    }
    .toolbar { ToolbarItem(placement: .topBarTrailing) { overflowMenu } }
    // The close dialog lives on its own host: two confirmationDialogs on one
    // view collapse to a single presentation, and the second silently wins.
    .confirmationDialog("Close pull request #\(pullRequest.number)?", isPresented: $confirmClose, titleVisibility: .visible) {
      Button("Close pull request", role: .destructive) { Task { await controller.closePullRequest(pullRequest) } }
      Button("Cancel", role: .cancel) {}
    }
  }

  // Reflects the live detail state, not the row we opened from: a merged pull
  // request must not still read "Open".
  private var stateChip: (text: String, tint: Color) {
    if detail.isMerged { return ("Merged", TetherColors.accent) }
    if detail.state == .closed { return ("Closed", TetherColors.textFaint) }
    if pullRequest.isDraft { return ("Draft", TetherColors.textSecondary) }
    return ("Open", TetherColors.success)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("#\(pullRequest.number) \(pullRequest.title)").font(.title3.weight(.bold))
        .foregroundStyle(TetherColors.textPrimary)
      Text("\(pullRequest.head) → \(pullRequest.base)").font(.caption.monospaced())
        .foregroundStyle(TetherColors.textSecondary).lineLimit(1).truncationMode(.middle)
      HStack(spacing: 6) {
        chip(stateChip.text, tint: stateChip.tint)
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

  /// The gate and the button are one card, so the reason sits with the control
  /// it explains rather than as a caption somewhere below it.
  @ViewBuilder
  private var mergeCard: some View {
    if detail.isMerged {
      mergeStatusCard(icon: "checkmark.seal.fill", tint: TetherColors.success, text: "Merged")
    } else if merging {
      mergeStatusCard(spinner: true, text: "Merging…")
    } else {
      gatedMergeCard
    }
  }

  private func mergeStatusCard(icon: String = "", tint: Color = TetherColors.accent, spinner: Bool = false, text: String) -> some View {
    HStack(spacing: 8) {
      if spinner {
        ProgressView().controlSize(.small).tint(TetherColors.accent)
      } else {
        Image(systemName: icon).foregroundStyle(tint)
      }
      Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
      Spacer(minLength: 0)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .tetherCard()
  }

  private var gatedMergeCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        if detail.gate == .computing {
          ProgressView().controlSize(.small).tint(TetherColors.accent)
        } else {
          Image(systemName: gateIcon).foregroundStyle(gateTint)
        }
        Text(detail.gate.reason)
          .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
        Spacer(minLength: 0)
      }

      Button { confirmMerge = true } label: {
        Text(defaultMethod?.label ?? "Merge pull request")
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity).padding(.vertical, 12)
          // A Text only hit-tests its glyphs; without this the padded capsule
          // around the label is dead to taps.
          .contentShape(Capsule())
      }
      .background(canMerge ? TetherColors.accent : TetherColors.surface, in: Capsule())
      .foregroundStyle(canMerge ? TetherColors.onAccent : TetherColors.textFaint)
      .overlay(Capsule().strokeBorder(canMerge ? .clear : TetherColors.border))
      .buttonStyle(TetherPressStyle())
      .disabled(!canMerge)
      .accessibilityIdentifier("pullRequestMerge")
      .accessibilityHint(canMerge ? "Merges this pull request" : detail.gate.reason)

      // Only being out of date has a fix this app can perform; a draft, a
      // conflict and a missing review are all resolved outside it.
      if detail.gate == .behind {
        HStack(spacing: 10) {
          Text("Update the branch to merge.")
            .font(.caption).foregroundStyle(TetherColors.textSecondary)
          Spacer(minLength: 0)
          Button("Update") { Task { await controller.updatePullRequest(pullRequest) } }
            .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.accent)
        }
      }

      if canMerge, methods.isEmpty {
        Text("This repository allows no merge method.")
          .font(.caption).foregroundStyle(TetherColors.textSecondary)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .tetherCard()
    .confirmationDialog("Merge #\(pullRequest.number)?", isPresented: $confirmMerge, titleVisibility: .visible) {
      ForEach(methods) { method in
        Button(method.label) {
          Task {
            merging = true
            let merged = await controller.mergePullRequest(pullRequest, method: method)
            merging = false
            // The merge call already told us it succeeded; flip in place rather
            // than race GitHub's state propagation on a re-fetch.
            if merged { detail = detail.markedMerged() } else { await refreshDetail() }
          }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("\(pullRequest.head) → \(pullRequest.base)")
    }
  }

  private var reviewChanges: some View {
    Button(action: openDiff) {
      HStack(spacing: 10) {
        // Fixed leading slot: the spinner is narrower than the icon, so without
        // it the label jumps sideways when a diff starts loading.
        Group {
          if loadingDiff {
            ProgressView().controlSize(.small).tint(TetherColors.accent)
          } else {
            Image(systemName: "doc.text.magnifyingglass")
          }
        }
        .frame(width: 22)
        Text("Review changes").font(.subheadline.weight(.semibold))
        Spacer(minLength: 0)
        Image(systemName: "chevron.right").font(.caption).foregroundStyle(TetherColors.textFaint)
      }
      .padding(.horizontal, 14).padding(.vertical, 13)
      .contentShape(Rectangle())
    }
    .buttonStyle(TetherPressStyle())
    .foregroundStyle(TetherColors.accent)
    .tetherCard()
  }

  private var overflowMenu: some View {
    Menu {
      Button { openDiff() } label: { Label("Review changes", systemImage: "doc.text.magnifyingglass") }
      Button { Task { await controller.checkoutPullRequest(pullRequest) } } label: {
        Label("Checkout branch", systemImage: "arrow.down.to.line")
      }
      Button { Task { await controller.updatePullRequest(pullRequest) } } label: {
        Label("Update branch", systemImage: "arrow.triangle.merge")
      }
      Divider()
      Button {
        if let url = URL(string: pullRequest.url) { UIApplication.shared.open(url) }
      } label: { Label("Open in GitHub", systemImage: "safari") }
      Button {
        acknowledgeCopy(pullRequest.url, announce: "Link copied", into: $showCopied)
      } label: { Label("Copy link", systemImage: "doc.on.doc") }
      Divider()
      Button(role: .destructive) { confirmClose = true } label: {
        Label("Close pull request", systemImage: "xmark.circle")
      }
    } label: {
      Image(systemName: "ellipsis.circle")
    }
    .accessibilityLabel("Pull request actions")
    .accessibilityIdentifier("pullRequestActions")
  }

  private var methods: [GitMergeMethod] { detail.methods }
  private var canMerge: Bool { detail.gate.canMerge && !methods.isEmpty }
  /// Squash is the common answer; otherwise whatever the repository allows.
  private var defaultMethod: GitMergeMethod? {
    methods.contains(.squash) ? .squash : methods.first
  }

  private var gateIcon: String {
    switch detail.gate {
    case .ready: "checkmark.circle.fill"
    case .conflicted: "exclamationmark.octagon"
    case .draft: "pencil.circle"
    case .behind, .blocked: "exclamationmark.triangle"
    case .computing: "clock"
    }
  }

  private var gateTint: Color {
    switch detail.gate {
    case .ready: TetherColors.success
    case .conflicted: TetherColors.danger
    case .behind, .blocked, .draft: TetherColors.warning
    case .computing: TetherColors.textFaint
    }
  }

  private func openDiff() {
    guard !loadingDiff else { return }
    loadingDiff = true
    Task {
      diffFiles = DiffFile.group(await controller.pullRequestDiff(pullRequest))
      loadingDiff = false
      showDiff = true
    }
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
