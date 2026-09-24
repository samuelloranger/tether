import Foundation
import SwiftUI
import PhotosUI

/// Lets a `@Sendable` stream callback carry its parse buffer across chunks. Calls arrive
/// serially; the lock only satisfies `Sendable`.
final class LockedBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value
  init(_ value: Value) { stored = value }
  var value: Value {
    get { lock.lock(); defer { lock.unlock() }; return stored }
    set { lock.lock(); defer { lock.unlock() }; stored = newValue }
  }

  /// Read-modify-write under one lock; `value += 1` would take it twice.
  func update<T>(_ body: (inout Value) -> T) -> T {
    lock.lock(); defer { lock.unlock() }
    return body(&stored)
  }
}

public struct PullRequestDetail: Equatable, Sendable {
  public let checks: [GitCheck]
  public let body: String
  public let gate: GitMergeGate
  public let methods: [GitMergeMethod]
  public let state: PRState
  public let fetchedAt: Date

  public var isMerged: Bool { state == .merged }

  /// A live check snapshot from the watch stream, leaving the rest as fetched.
  public func withChecks(_ checks: [GitCheck]) -> PullRequestDetail {
    PullRequestDetail(checks: checks, body: body, gate: gate, methods: methods, state: state, fetchedAt: fetchedAt)
  }

  /// After a successful merge we know the outcome without waiting for GitHub's
  /// state to propagate to the next fetch.
  public func markedMerged() -> PullRequestDetail {
    PullRequestDetail(checks: checks, body: body, gate: gate, methods: [], state: .merged, fetchedAt: fetchedAt)
  }

  public static let empty = PullRequestDetail(checks: [], body: "", gate: .computing, methods: [], state: .open, fetchedAt: .distantPast)
}

/// Drives one SSH-backed terminal attached to a zmx session, so the shell survives disconnects.
@MainActor
@Observable
public final class SSHTerminalController {
  public enum GitWorkspacePayload: Sendable, Equatable {
    case all
    case changes
    case commits
    case pullRequests
  }

  public enum Status: Equatable {
    case connecting
    case connected
    /// The transport dropped under a live session. Distinct from `.failed` so reconnect gates,
    /// which only skip on `.connected`, actually redial.
    case disconnected
    case failed(String)
  }

  /// What the terminal overlay says while there is no live session. Text plus
  /// an icon — connection state is never carried by colour alone.
  public struct ConnectionCopy: Equatable {
    /// A spinner means "wait"; a symbol means "look". Retry is offered for an
    /// error and nothing else, so the affordance cannot disagree with the art.
    public enum Indicator: Equatable {
      case spinner
      case warning(symbol: String)
      case error(symbol: String)

      public var offersRetry: Bool { if case .error = self { return true } else { return false } }
    }

    public var message: String
    public var indicator: Indicator
    /// The header lamp's one word for the same state.
    public var shortLabel: String
  }

  /// Why a dial is being asked for. Everything automatic passes through the
  /// recovery gate; a person tapping Retry is answering it, so it does not.
  public enum ConnectTrigger: Equatable {
    case initial, foreground, networkPath, manual

    var bypassesRecoveryGate: Bool { self == .manual || self == .initial }
  }

  public enum TransferState: Equatable {
    case idle
    case sending(String)
    case sent(String)
    case failed(String)
  }

  public static let defaultAttach = "default"

  public var snapshot: TerminalFrame?
  public private(set) var status: Status = .connecting
  public private(set) var mouseMode: MouseMode = .off
  public private(set) var mouseSgr = true
  public let title: String
  public private(set) var sessionKey: String
  public private(set) var sessions: [ZmxSession] = []
  public private(set) var attach: String
  /// False on a host with no zmx sessions: the PTY is a bare login shell until one is created.
  public private(set) var hasSession = true
  public private(set) var gitLines: [GitDiffLine] = []
  public private(set) var gitFiles: [DiffFile] = []
  public private(set) var gitBranch = ""
  public private(set) var gitCommits: [GitCommit] = []
  public private(set) var gitPullRequests: [GitPullRequest] = []
  /// Why the list is empty, when the reason is not "none open".
  public private(set) var gitPullRequestNotice: String?
  /// False until a load that actually fetched pull requests completes, so an
  /// empty list before the first fetch reads as loading, not "none open".
  public private(set) var gitPullRequestsLoaded = false
  public private(set) var gitError: String?
  public private(set) var gitActionMessage: String?
  public private(set) var gitLoading = false
  public private(set) var transfer: TransferState = .idle
  public private(set) var reachability: NetworkReachability?
  public private(set) var agentStatuses: [String: AgentStatus] = [:]
  public private(set) var agentAlert: AgentStatus?
  /// `nil` until the first read on this connection — that read is a baseline, not news.
  private var agentStatusBaseline: [String: AgentStatus]?
  private var agentStatusAvailable = true
  private var lastAgentStatusRead: Date?
  private var knownHostLabels: Set<String> = []
  var clock: () -> Date = Date.init
  public nonisolated static let backgroundGrace: TimeInterval = 15
  /// Set while backgrounded past the grace period: nothing but a return to the
  /// foreground (or a person tapping Retry) may redial.
  public private(set) var isSuspended = false

  private let pathObserver = NetworkPathObserver()
  /// Opened lazily on first use, which is always after the terminal connects.
  private let control: ControlConnection
  static let zmx = "~/.local/bin/zmx"
  private static let notify = "~/.local/bin/tether-notify"
  static let agentStatusCommand =
    "if [ -x \(notify) ]; then \(notify) status 2>/dev/null; else echo __tether_notify_missing; fi"
  private static let agentStatusStaleAfter: TimeInterval = 30
  private let pipeline = TerminalPipeline()
  private let config: SSHConnectionConfig
  private let hostKeyStore: HostKeyStore
  private let pushIdentity: PushRegistrar.PushIdentity?
  private var didRegisterPush = false
  private var connectInFlight = false
  typealias Dialer = @Sendable (SSHConnectionConfig, HostKeyStore) async throws -> any TerminalByteStream
  private let dial: Dialer
  /// Set by `leave()`. A dial still in flight must not adopt its stream after it.
  private var left = false
  private var didChooseInitialSession = false
  /// Set when the host had no sessions on first connect: skip the `zmx attach`
  /// so nothing is auto-created. Cleared the moment the user creates a session.
  private var pendingNoSession = false
  private var lastCols: UInt16 = 80
  private var lastRows: UInt16 = 24

  init(
    title: String,
    config: SSHConnectionConfig,
    hostKeyStore: HostKeyStore,
    attach: String = defaultAttach,
    pushIdentity: PushRegistrar.PushIdentity? = nil,
    dial: @escaping Dialer = { try await SSHConnector.connect(config: $0, store: $1) },
    control: ControlConnection? = nil
  ) {
    self.title = title
    self.config = config
    self.hostKeyStore = hostKeyStore
    self.attach = attach
    self.pushIdentity = pushIdentity
    self.dial = dial
    self.control = control ?? ControlConnection(config: config, store: hostKeyStore)
    // Stable across zmx switches — one continuous connection/grid.
    self.sessionKey = "ssh:\(config.host):\(config.port)"
    observe()
  }

  private func observe() {
    Task { [weak self] in
      guard let snapshots = self?.pipeline.snapshots else { return }
      for await snapshot in snapshots { self?.snapshot = snapshot }
    }
    Task { [weak self] in
      guard let events = self?.pipeline.events else { return }
      for await event in events { self?.apply(event) }
    }
  }

  public func connect(trigger: ConnectTrigger = .initial) async {
    guard !left else { return }
    if isSuspended, trigger != .manual { return }
    if !trigger.bypassesRecoveryGate,
      !Self.shouldRedialOnForeground(status: status, dialing: connectInFlight, reachability: reachability) {
      return
    }
    // Serialize: the initial .task connect and a scenePhase .active reconnect can
    // both fire before the first is `.connected`, otherwise double-attaching.
    if connectInFlight { return }
    connectInFlight = true
    defer { connectInFlight = false }
    status = .connecting
    // Release the live session first: authenticating a second connection alongside it fails,
    // and connectSSH only disconnects after the new auth succeeds.
    await pipeline.disconnect()
    // A redial means the path under us changed; the control session rode the
    // same one and may be blocked on it.
    if trigger != .initial { control.reset() }
    await chooseInitialSessionIfNeeded()
    // libssh2 auth/transport fails transiently with several connections opening at once.
    // A host-key mismatch is never retried — that must fail loudly.
    for attempt in 0..<3 {
      guard !left else { return }
      do {
        let stream = try await dial(config, hostKeyStore)
        guard !left, !isSuspended else {
          await stream.close()
          return
        }
        await pipeline.connectSSH(transport: stream, key: sessionKey)
        // Backgrounded past the grace while this was attaching: let go, or zmx keeps counting us.
        guard !isSuspended else {
          await pipeline.disconnect()
          return
        }
        status = .connected
        agentStatusBaseline = nil
        agentStatusAvailable = true
        // A fresh PTY is 80x24 and the view never re-reports on a switch; push the last size.
        pipeline.outbound.yield(.serverResize(cols: lastCols, rows: lastRows))
        // Zero-session host: leave the bare login shell, don't auto-create.
        if pendingNoSession {
          hasSession = false
        } else {
          hasSession = true
          pipeline.outbound.yield(.input(ZmxSwitch.attachCommand(zmx: Self.zmx, name: attach), key: sessionKey))
        }
        schedulePushRegister()
        Task { await refreshSessions() }
        return
      } catch let error as SSHConnectError {
        if case .hostKeyMismatch = error { status = .failed(Self.describe(error)); return }
        if attempt == 2 { status = .failed(Self.describe(error)); return }
      } catch {
        if attempt == 2 { status = .failed(Self.describe(error)); return }
      }
      try? await Task.sleep(nanoseconds: 500_000_000)
    }
  }

  /// First connect only: attach "default" or else the newest session; create nothing on an
  /// empty host. An explicit target (a switch, the launch-env attach) is left alone.
  private func chooseInitialSessionIfNeeded() async {
    guard !didChooseInitialSession else { return }
    didChooseInitialSession = true
    guard attach == Self.defaultAttach else { return }
    guard let out = try? await control.exec("\(Self.zmx) ls") else { return }
    let existing = ZmxSession.parse(out)
    if existing.isEmpty { pendingNoSession = true; return }
    guard !existing.contains(where: { $0.name == Self.defaultAttach }) else { return }
    attach = existing.max(by: { $0.created < $1.created })?.name ?? attach
  }

  /// Best-effort, once per connection. Delayed so its extra SSH connection doesn't race the
  /// terminal handshake.
  private func schedulePushRegister() {
    guard !didRegisterPush, let id = pushIdentity else { return }
    didRegisterPush = true
    let command = "\(Self.notify) register \(shellQuote(id.token)) \(shellQuote(id.secretKey)) \(shellQuote(id.label))"
    Task {
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      _ = try? await control.exec(command)
    }
  }

  /// Retries when empty: a just-attached session can miss the first `zmx ls`
  /// (separate connection) before the daemon registers it.
  public func refreshSessions() async {
    for attempt in 0..<3 {
      if let output = try? await control.exec("\(Self.zmx) ls") {
        let parsed = ZmxSession.parse(output)
        if !parsed.isEmpty || attempt == 2 { sessions = parsed; break }
      }
      try? await Task.sleep(nanoseconds: 400_000_000)
    }
    await refreshAgentStatus()
  }

  public var othersWaiting: Bool {
    agentStatuses.values.contains { $0.session != attach && $0.state == .waiting }
  }

  public func refreshAgentStatus() async {
    guard agentStatusAvailable, status == .connected else { return }
    guard let output = try? await control.exec(Self.agentStatusCommand) else {
      if let last = lastAgentStatusRead, clock().timeIntervalSince(last) > Self.agentStatusStaleAfter {
        agentStatuses = [:]
      }
      return
    }
    // An older binary without `status` prints usage to stderr and nothing we can parse.
    if output.contains("__tether_notify_missing") || !output.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[") {
      agentStatusAvailable = false
      agentStatuses = [:]
      return
    }
    let parsed = AgentStatus.parse(output)
    let byName = Dictionary(parsed.map { ($0.session, $0) }, uniquingKeysWith: { first, _ in first })
    if let shown = agentAlert, byName[shown.session]?.state != shown.state { agentAlert = nil }
    if let alert = AgentStatusChanges.alerts(old: agentStatusBaseline, new: parsed, current: attach).first {
      agentAlert = alert
    }
    agentStatusBaseline = byName
    agentStatuses = byName
    lastAgentStatusRead = clock()
    knownHostLabels.formUnion(parsed.compactMap(\.hostLabel))
  }

  public func dismissAgentAlert() { agentAlert = nil }

  /// Whether a push or link labelled `label` is about this host, as learnt from status reads.
  public func answers(toHostLabel label: String) -> Bool { knownHostLabels.contains(label) }

  /// The auto-hide timer's callback: a newer banner for the same session must survive it.
  public func expireAgentAlert(_ alert: AgentStatus) {
    if agentAlert == alert { agentAlert = nil }
  }

  /// A foreground push is hidden only when the in-app banner is showing it; a push with no
  /// state behind it (an agent outside zmx, a baseline read) must still reach the user.
  public func coversPush(_ link: SessionDeepLink) async -> Bool {
    guard status == .connected else { return false }
    await refreshAgentStatus()
    guard knownHostLabels.contains(link.identityName), link.sessionId != attach else { return false }
    return agentAlert?.session == link.sessionId
  }

  /// Detaches the zmx client holding the PTY and attaches from the shell underneath, so the
  /// program in the session we leave is never typed into and keeps running.
  public func switchSession(to name: String) async {
    // Skip only when it's the same session we're already on. When there is no
    // session yet (empty-state host), attach even if the name equals `attach`.
    guard name != attach || !hasSession else { return }
    let wasAttached = hasSession
    attach = name
    if agentAlert?.session == name { agentAlert = nil }
    pendingNoSession = false
    hasSession = true
    let connected = { if case .connected = status { return true } else { return false } }()
    guard case let .type(typing) = ZmxSwitch.strategy(connected: connected, attached: wasAttached) else {
      await connect()
      return
    }
    for (index, write) in ZmxSwitch.writes(typing: typing, zmx: Self.zmx, name: name).enumerated() {
      // Separate writes: the detach key's own read must not carry the command.
      if index > 0 { try? await Task.sleep(nanoseconds: ZmxSwitch.settleNanoseconds) }
      pipeline.outbound.yield(.input(write, key: sessionKey))
    }
    await refreshSessions()
  }

  /// Switch away first when killing the current session — killing the one we're
  /// attached to would drop our own PTY.
  public func killSession(_ name: String) async {
    if name == attach {
      await refreshSessions()
      if let next = sessions.first(where: { $0.name != name })?.name {
        await switchSession(to: next)
      } else {
        // Killed the only session — drop to the empty state, don't recreate one.
        hasSession = false
        pendingNoSession = true
      }
    }
    _ = try? await control.exec("\(Self.zmx) kill \(shellQuote(name)) --force")
    await refreshSessions()
  }

  /// `zmx ls` only reports the login dir, so read the shell's `/proc/<pid>/cwd`.
  private func currentCwd() async -> String? {
    var session = sessions.first(where: { $0.name == attach })
    if session == nil {
      await refreshSessions()
      session = sessions.first(where: { $0.name == attach })
    }
    guard let session else { return nil }
    if let live = try? await control.exec("readlink /proc/\(session.pid)/cwd 2>/dev/null") {
      let trimmed = live.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.hasPrefix("/") { return trimmed }
    }
    await refreshSessions()
    guard let refreshed = sessions.first(where: { $0.name == attach }) else {
      return session.displayCwd.hasPrefix("/") ? session.displayCwd : nil
    }
    if let live = try? await control.exec("readlink /proc/\(refreshed.pid)/cwd 2>/dev/null") {
      let trimmed = live.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.hasPrefix("/") { return trimmed }
    }
    return refreshed.displayCwd.hasPrefix("/") ? refreshed.displayCwd : nil
  }

  /// SCP-sends to the current session's live cwd. Returns the remote path.
  @discardableResult
  public func sendFile(data: Data, filename: String) async -> String? {
    let dir = await currentCwd()
    let remote = dir.map { "\($0)/\(filename)" } ?? filename
    transfer = .sending(filename)
    do {
      // Its own connection: commands are serialized on the control one, and a
      // large upload would hold the session list and the git screen behind it.
      try await SSHConnector.scpSend(config: config, store: hostKeyStore, data: data, remotePath: remote)
      transfer = .sent(remote)
      return remote
    } catch {
      transfer = .failed(Self.describe(error))
      return nil
    }
  }

  public func clearTransfer() { transfer = .idle }

  public func sendPickedMedia(_ item: PhotosPickerItem, isVideo: Bool) async {
    switch await MediaTransfer.load(item, isVideo: isVideo) {
    case let .ready(name, data):
      let remote = await sendFile(data: data, filename: name)
      if let remote { sendInput(shellQuote(remote)) }
    case let .failed(message):
      reportTransferFailure(message)
    }
  }

  /// A transfer that failed before any SSH work reuses the upload banner.
  private func reportTransferFailure(_ message: String) { transfer = .failed(message) }

  public func loadGitWorkspace(payload: GitWorkspacePayload = .all) async {
    gitLoading = true
    defer { gitLoading = false }
    gitError = nil
    guard let cwd = await currentCwd() else {
      gitLines = []
      gitFiles = []
      gitError = "No working directory for this session."
      return
    }
    // The sentinel marks "not a repo" — an empty diff is a valid, distinct result.
    let sentinel = "__TETHER_NOTREPO__"
    let q = shellQuote(cwd)
    let repositoryGuard = "git -C \(q) rev-parse --is-inside-work-tree >/dev/null 2>&1"
    let diffCommand: String
    let commitsCommand: String
    let pullRequestsCommand: String
    switch payload {
    case .all, .pullRequests:
      diffCommand = payload == .all ? "git -C \(q) --no-pager diff 2>&1" : "printf ''"
      commitsCommand = payload == .all ? "git -C \(q) --no-pager log -n 50 --format='%h%x1f%s%x1f%an%x1f%ct%x1e'" : "printf ''"
      // Keep gh's stderr: swallowing it into an empty list made the screen blame
      // a missing CLI for a repository with nothing open.
      let ghMissing = shellQuote(GitRepositoryModel.ghMissingSentinel)
      pullRequestsCommand = "if command -v gh >/dev/null 2>&1; then (cd \(q) && gh pr list --state all --limit 50 --json number,title,headRefName,baseRefName,url,isDraft,changedFiles,reviewDecision,state 2>&1); else printf '%s' \(ghMissing); fi"
    case .changes:
      diffCommand = "git -C \(q) --no-pager diff 2>&1"
      commitsCommand = "printf ''"
      pullRequestsCommand = "printf ''"
    case .commits:
      diffCommand = "printf ''"
      commitsCommand = "git -C \(q) --no-pager log -n 50 --format='%h%x1f%s%x1f%an%x1f%ct%x1e'"
      pullRequestsCommand = "printf ''"
    }
    let command = "if \(repositoryGuard); then "
      + "\(diffCommand); printf '\\035'; "
      + "git -C \(q) branch --show-current; printf '\\035'; "
      + "\(commitsCommand); printf '\\035'; "
      + "\(pullRequestsCommand); "
      + "else printf '%s\\035\\035\\035[]' \(shellQuote(sentinel)); fi"
    do {
      let output = try await control.exec(command)
      guard let sections = GitRepositoryModel.workspaceSections(output) else {
        gitLines = []
        gitFiles = []
        gitBranch = ""
        gitCommits = []
        gitPullRequests = []
        gitPullRequestNotice = nil
        gitError = "Could not read the git workspace."
        return
      }
      let diff = sections.diff
      if diff.trimmingCharacters(in: .whitespacesAndNewlines) == sentinel {
        gitLines = []
        gitFiles = []
        gitBranch = ""
        gitCommits = []
        gitPullRequests = []
        gitPullRequestNotice = nil
        gitError = "Not a git repository:\n\(cwd)"
        return
      }
      gitBranch = GitRepositoryModel.branch(from: sections.branch)
      switch payload {
      case .all:
        let lines = GitDiffModel.classify(diff)
        gitLines = lines
        gitFiles = DiffFile.group(lines)
        gitCommits = GitRepositoryModel.commits(from: sections.commits)
        switch GitRepositoryModel.pullRequestResult(from: sections.pullRequests) {
        case let .list(pulls):
          gitPullRequests = pulls
          gitPullRequestNotice = nil
        case .toolMissing:
          gitPullRequests = []
          gitPullRequestNotice = "GitHub CLI isn't installed on this host."
        case let .failed(reason):
          gitPullRequests = []
          gitPullRequestNotice = reason
        }
        gitPullRequestsLoaded = true
      case .changes:
        let lines = GitDiffModel.classify(diff)
        gitLines = lines
        gitFiles = DiffFile.group(lines)
      case .commits:
        gitCommits = GitRepositoryModel.commits(from: sections.commits)
      case .pullRequests:
        switch GitRepositoryModel.pullRequestResult(from: sections.pullRequests) {
        case let .list(pulls):
          gitPullRequests = pulls
          gitPullRequestNotice = nil
        case .toolMissing:
          gitPullRequests = []
          gitPullRequestNotice = "GitHub CLI isn't installed on this host."
        case let .failed(reason):
          gitPullRequests = []
          gitPullRequestNotice = reason
        }
        gitPullRequestsLoaded = true
      }
    } catch {
      gitLines = []
      gitFiles = []
      gitError = Self.describe(error)
    }
  }

  /// Its own dial keeps the long-lived watch off the serial control connection. False when the
  /// dial failed, so the caller falls back rather than assume the checks are done.
  public func streamChecks(
    _ pullRequest: GitPullRequest,
    onSnapshot: @escaping @MainActor ([GitCheck]) -> Void
  ) async -> Bool {
    guard let cwd = await currentCwd() else { return false }
    let command = "cd \(shellQuote(cwd)) && gh pr checks \(pullRequest.number) --watch --interval 15 2>&1"
    // The stream arrives in chunks that do not respect snapshot boundaries, so
    // accumulate and emit each block only once the next header proves it whole.
    let buffer = LockedBox("")
    let deliver: @Sendable (String) -> Bool = { chunk in
      let combined = buffer.value + chunk
      let (blocks, remainder) = GitRepositoryModel.watchSnapshots(splitting: combined)
      buffer.value = remainder
      for block in blocks {
        let checks = GitRepositoryModel.watchChecks(fromBlock: block)
        if !checks.isEmpty { Task { @MainActor in onSnapshot(checks) } }
      }
      return true
    }
    do {
      try await SSHConnector.execStream(config: config, store: hostKeyStore, command: command, onChunk: deliver)
      return true
    } catch {
      return false
    }
  }

  /// Checks and description for one pull request, in a single round trip.
  public func loadPullRequestDetail(_ pullRequest: GitPullRequest) async -> PullRequestDetail {
    guard let cwd = await currentCwd() else { return .empty }
    let prView = "gh pr view \(pullRequest.number) --json statusCheckRollup,body,mergeable,mergeStateStatus,isDraft,state 2>/dev/null"
    let repoView = "gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed 2>/dev/null"
    let command = "cd \(shellQuote(cwd)) && { \(prView); printf '\\036'; \(repoView); }"
    guard let raw = try? await control.exec(command) else { return .empty }
    let payloads = raw.split(separator: "\u{1E}", maxSplits: 1, omittingEmptySubsequences: false)
    guard let prPayload = payloads.first,
      let object = try? JSONSerialization.jsonObject(with: Data(prPayload.utf8)) as? [String: Any]
    else { return .empty }
    let checks: [GitCheck]
    if let rollup = object["statusCheckRollup"],
      let encoded = try? JSONSerialization.data(withJSONObject: rollup) {
      checks = GitRepositoryModel.checks(from: String(decoding: encoded, as: UTF8.self))
    } else {
      checks = []
    }
    let methods = payloads.count == 2
      ? GitRepositoryModel.allowedMergeMethods(from: String(payloads[1]))
      : []
    let state = PRState(rawValue: (object["state"] as? String ?? "").uppercased()) ?? .open
    return PullRequestDetail(
      checks: checks,
      body: (object["body"] as? String) ?? "",
      gate: GitRepositoryModel.mergeGate(from: String(prPayload)),
      methods: methods,
      state: state,
      fetchedAt: Date())
  }

  /// One commit's patch, kept apart from `gitLines` so opening a commit does
  /// not replace the working-tree diff behind it.
  public func commitDiff(_ commit: GitCommit) async -> (body: String, lines: [GitDiffLine]) {
    guard let cwd = await currentCwd() else { return ("", []) }
    // %x1e ends the message: git's own `---` separator reads as a removed line.
    let command = "git -C \(shellQuote(cwd)) --no-pager show \(shellQuote(commit.id)) --patch --format=%b%x1e 2>&1"
    guard let raw = try? await control.exec(command) else { return ("", []) }
    let shown = GitDiffModel.commitShow(raw)
    return (shown.body, GitDiffModel.classify(shown.patch))
  }

  /// The pull request's own patch, returned rather than stored: the working
  /// tree's diff lives in `gitLines`, and the refresh loop would overwrite this.
  public func pullRequestDiff(_ pullRequest: GitPullRequest) async -> [GitDiffLine] {
    guard let cwd = await currentCwd() else { return [] }
    let command = "cd \(shellQuote(cwd)) && gh pr diff \(pullRequest.number) 2>&1"
    guard let raw = try? await control.exec(command) else { return [] }
    return GitDiffModel.classify(raw)
  }

  public func checkoutPullRequest(_ pullRequest: GitPullRequest) async {
    await runGitAction("Checking out #\(pullRequest.number)…") { cwd in
      let q = shellQuote(cwd)
      let branch = shellQuote("tether/pr/\(pullRequest.number)")
      return "git -C \(q) fetch origin pull/\(pullRequest.number)/head:\(branch) && git -C \(q) switch \(branch)"
    }
  }

  public func updatePullRequest(_ pullRequest: GitPullRequest) async {
    await runGitAction("Updating #\(pullRequest.number)…") { cwd in
      let branch = shellQuote("tether/pr/\(pullRequest.number)")
      return "git -C \(shellQuote(cwd)) fetch origin pull/\(pullRequest.number)/head:\(branch)"
    }
  }

  public func closePullRequest(_ pullRequest: GitPullRequest) async {
    await runGitAction("Closing #\(pullRequest.number)…") { cwd in
      "cd \(shellQuote(cwd)) && gh pr close \(pullRequest.number)"
    }
  }

  @discardableResult
  public func mergePullRequest(_ pullRequest: GitPullRequest, method: GitMergeMethod) async -> Bool {
    await runGitAction("Merging #\(pullRequest.number)…") { cwd in
      "cd \(shellQuote(cwd)) && gh pr merge \(pullRequest.number) \(method.flag)"
    }
  }

  @discardableResult
  private func runGitAction(_ message: String, command: (String) -> String) async -> Bool {
    gitActionMessage = message
    guard let cwd = await currentCwd() else { gitActionMessage = "No working directory for this session."; return false }
    do {
      _ = try await control.exec(command(cwd))
      gitActionMessage = nil
      await loadGitWorkspace()
      return true
    } catch { gitActionMessage = Self.describe(error); return false }
  }

  /// Foreground-redial: never reuse a socket iOS may have killed while suspended.
  /// Shares the gate with the path observer so the two triggers can't race.
  public func reconnectIfNeeded() async {
    await connect(trigger: .foreground)
  }

  /// zmx counts an attached phone as a viewer and the host skips its pushes, so a
  /// phone left in the background must actually let go.
  public func detachAfterGrace(_ grace: TimeInterval = backgroundGrace) async {
    try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000))
    guard !Task.isCancelled else { return }
    await suspendNow()
  }

  public func suspendNow() async {
    guard !left, !isSuspended else { return }
    isSuspended = true
    status = .disconnected
    await pipeline.disconnect()
    await control.close()
  }

  public func enterForeground() async {
    isSuspended = false
    await reconnectIfNeeded()
  }

  /// Watch the network path for this screen. Redials only when a path *becomes*
  /// usable — a usable path is a route, never proof the host answered.
  public func startNetworkWatch() {
    pathObserver.start { [weak self] value in self?.pathChanged(value) }
  }

  public func stopNetworkWatch() { pathObserver.stop() }

  func pathChanged(_ value: NetworkReachability) {
    let previous = reachability
    reachability = value
    if status == .connected, Self.pathInvalidatesConnection(previous: previous, next: value) {
      markDisconnectedAndReconnect()
      return
    }
    guard Self.pathBecameUsable(previous: previous, next: value) else { return }
    Task { await connect(trigger: .networkPath) }
  }

  /// The kernel only notices a dead route after its retransmit timeout; the monitor knows now.
  /// A new preferred interface with the old one still up leaves the connection alone.
  nonisolated static func pathInvalidatesConnection(
    previous: NetworkReachability?, next: NetworkReachability
  ) -> Bool {
    guard let previous, previous.isUsable else { return false }
    guard next.isUsable else { return true }
    guard let used = previous.primary else { return false }
    return !next.interfaces.contains(used)
  }

  /// Only an edge counts: the monitor re-reports the same path on every interface change, and
  /// the gate inside `connect` only sees the current reading.
  nonisolated static func pathBecameUsable(
    previous: NetworkReachability?, next: NetworkReachability
  ) -> Bool {
    next.isUsable && previous?.isUsable != true
  }

  /// Shared tail of both triggers: never disturb a live or in-flight connection,
  /// and never dial into a path that cannot carry the connection.
  nonisolated static func shouldRedialOnForeground(
    status: Status, dialing: Bool, reachability: NetworkReachability?
  ) -> Bool {
    if dialing { return false }
    switch status {
    case .connected, .connecting: return false
    case .disconnected, .failed: break
    }
    switch reachability?.availability {
    case .offline, .requiresConnection: return false
    case .usable, nil: return true
    }
  }

  /// Overlay copy for a terminal without a live session. A real SSH or host-key
  /// failure always outranks network copy — that is what the user must act on.
  nonisolated static func connectionCopy(status: Status, reachability: NetworkReachability?) -> ConnectionCopy? {
    switch status {
    case .connected:
      return nil
    case .connecting:
      return ConnectionCopy(message: "Connecting…", indicator: .spinner, shortLabel: "connecting")
    case let .failed(message):
      return ConnectionCopy(
        message: message, indicator: .error(symbol: "exclamationmark.triangle"), shortLabel: "error")
    case .disconnected:
      // On a dead path the session is waiting for the network, not the host.
      switch reachability?.availability {
      case .offline:
        return ConnectionCopy(
          message: "Waiting for a network connection",
          indicator: .warning(symbol: "wifi.slash"), shortLabel: "no network")
      case .requiresConnection:
        return ConnectionCopy(
          message: "Network needs a connection",
          indicator: .warning(symbol: "exclamationmark.triangle"), shortLabel: "no network")
      case .usable, nil:
        return ConnectionCopy(
          message: "Connection lost — reconnecting…", indicator: .spinner, shortLabel: "reconnecting")
      }
    }
  }

  /// zmx runs an alt-screen session, so the local buffer only holds the current screen;
  /// `zmx history` is the real transcript.
  public func historyText() async -> String {
    if let out = try? await control.exec("\(Self.zmx) history \(shellQuote(attach))"),
      !out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return out
    }
    return await pipeline.historyText()
  }

  public func sendInput(_ text: String) { pipeline.outbound.yield(.input(text, key: sessionKey)) }
  public func sendPaste(_ text: String) { pipeline.outbound.yield(.paste(text, key: sessionKey)) }
  public func updateGrid(cols: UInt16, rows: UInt16) {
    lastCols = cols; lastRows = rows
    pipeline.outbound.yield(.localResize(cols: cols, rows: rows))
  }
  public func updateGridServer(cols: UInt16, rows: UInt16) {
    lastCols = cols; lastRows = rows
    pipeline.outbound.yield(.serverResize(cols: cols, rows: rows))
  }
  public func scroll(lines: Int32) { Task { await pipeline.scrollViewport(lines: lines) } }
  public func leave() async {
    left = true
    stopNetworkWatch()
    // Terminal first: the control queue may be held by a command on a dead path.
    await pipeline.disconnect()
    await control.close()
  }

  private func apply(_ event: TerminalPipelineEvent) {
    switch event {
    case let .mouseModes(mode, sgr):
      mouseMode = mode
      mouseSgr = sgr
    case .altScreen:
      // The pipeline needs it for resize; a switch no longer does — an inline
      // CLI agent holds the keyboard without ever taking the alt-screen.
      break
    case .error:
      markDisconnectedAndReconnect()
    }
  }

  /// Never fires on an intentional leave: the pipeline cancels its read task, which suppresses
  /// the error.
  private func markDisconnectedAndReconnect() {
    guard let next = Self.statusAfterTransportDrop(from: status) else { return }
    status = next
    // A drop caused by the network dying must not spin on a dead path: the
    // observer redials the moment a usable one comes back.
    Task { await self.connect(trigger: .foreground) }
  }

  /// `nil` while a reconnect is underway, so a late error from the old transport can't disturb it.
  nonisolated static func statusAfterTransportDrop(from current: Status) -> Status? {
    switch current {
    case .connecting: return nil
    case .connected, .disconnected, .failed: return .disconnected
    }
  }

  private static func describe(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? "Could not connect: \(error)"
  }
}
