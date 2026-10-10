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
  public enum GitWorkspacePayload: Sendable, Hashable {
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
  /// Bumped each time the bell rings, at most once per throttle window.
  public private(set) var bellRings = 0
  @ObservationIgnored private var bellThrottle = BellThrottle()
  /// A bell that arrives in the background grace period would otherwise buzz on return.
  @ObservationIgnored var appIsActive: @MainActor () -> Bool = { UIApplication.shared.applicationState == .active }
  /// What the programs in the attached session have reported: title, cwd, progress.
  public private(set) var terminalReport = TerminalReport.empty
  /// OSC 52 lands here. Only ever written, and never while the app is in the background.
  @ObservationIgnored var writeClipboard: @MainActor (String) -> Void = { UIPasteboard.general.string = $0 }
  public let title: String
  public private(set) var sessionKey: String
  public private(set) var sessions: [ZmxSession] = []
  public private(set) var attach: String
  /// False on a host with no zmx sessions: the PTY is a bare login shell until one is created.
  public private(set) var hasSession = true
  public private(set) var gitFiles: [DiffFile] = []
  /// Files git does not track yet; their contents load when opened.
  public private(set) var gitUntracked: [String] = []
  /// More untracked files exist than are listed.
  public private(set) var gitUntrackedTruncated = false
  /// The working-tree patch hit the size cap and was cut short.
  public private(set) var gitDiffTruncated = false
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
  /// One load per payload at a time: a second caller waits for the one in flight.
  @ObservationIgnored private var gitLoads: [GitWorkspacePayload: Task<Void, Never>] = [:]
  /// The patch `gitFiles` was parsed from: an unchanged poll skips the parse and the redraw.
  @ObservationIgnored private var gitRawDiff: String?
  /// HEAD when `gitCommits` was read, so a poll can skip an unmoved log.
  @ObservationIgnored private var gitHead: String?
  @ObservationIgnored private var gitCwd: String?
  @ObservationIgnored private var commitPatches: [String: GitPatch] = [:]
  @ObservationIgnored private var pullRequestPatches: [Int: (patch: GitPatch, at: Date)] = [:]
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
  /// `gh` talks to GitHub and can take seconds; on its own connection it never holds
  /// the session list or the diff behind it.
  private let ghControl: ControlConnection
  static let zmx = "~/.local/bin/zmx"
  private static let notify = "~/.local/bin/tether-notify"
  static let agentStatusCommand =
    "if [ -x \(notify) ]; then \(notify) status 2>/dev/null; else echo __tether_notify_missing; fi"
  private static let agentStatusStaleAfter: TimeInterval = 30
  private let pipeline: TerminalPipeline
  private var themeSequence: UInt64 = 0
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
  /// Once a settled size exists, only it reaches a fresh PTY: a local size can be a frame
  /// of a keyboard animation, and the surface would not resend the size it last settled.
  private var hasSettledGrid = false

  init(
    title: String,
    config: SSHConnectionConfig,
    hostKeyStore: HostKeyStore,
    attach: String = defaultAttach,
    pushIdentity: PushRegistrar.PushIdentity? = nil,
    theme: TerminalTheme = .tether,
    choosesInitialSession: Bool = true,
    dial: @escaping Dialer = { try await SSHConnector.connect(config: $0, store: $1) },
    control: ControlConnection? = nil,
    ghControl: ControlConnection? = nil
  ) {
    self.pipeline = TerminalPipeline(theme: theme)
    self.title = title
    self.config = config
    self.hostKeyStore = hostKeyStore
    self.attach = attach
    self.didChooseInitialSession = !choosesInitialSession
    self.pushIdentity = pushIdentity
    self.dial = dial
    self.control = control ?? ControlConnection(config: config, store: hostKeyStore)
    self.ghControl = ghControl ?? control ?? ControlConnection(config: config, store: hostKeyStore)
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
    if trigger != .initial {
      control.reset()
      if ghControl !== control { ghControl.reset() }
    }
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

  /// Claude's question held in this very session: its dialog shows in the terminal, and the
  /// answer sheet can answer it instead.
  public var heldQuestion: AgentStatus? {
    guard let status = agentStatuses[attach], status.held == "question",
          status.version != dismissedQuestionVersion
    else { return nil }
    return status
  }

  private var dismissedQuestionVersion: String?

  public func dismissHeldQuestion() { dismissedQuestionVersion = heldQuestion?.version }

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
    let departing = attach
    attach = name
    if agentAlert?.session == name { agentAlert = nil }
    pendingNoSession = false
    hasSession = true
    let connected = { if case .connected = status { return true } else { return false } }()
    guard case let .type(typing) = ZmxSwitch.strategy(connected: connected, attached: wasAttached) else {
      await connect()
      if wasAttached && departing != name { flushPushInBackground(session: departing) }
      return
    }
    for (index, write) in ZmxSwitch.writes(typing: typing, zmx: Self.zmx, name: name).enumerated() {
      // Separate writes: the detach key's own read must not carry the command.
      if index > 0 { try? await Task.sleep(nanoseconds: ZmxSwitch.settleNanoseconds) }
      pipeline.outbound.yield(.input(write, key: sessionKey))
    }
    if wasAttached { flushPushInBackground(session: departing) }
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
    // No /proc (a macOS host): the shell's own report beats the directory the session started in.
    if let reported = terminalReport.cwd { return reported }
    return refreshed.displayCwd.hasPrefix("/") ? refreshed.displayCwd : nil
  }

  public enum SendDestination: Equatable {
    case sessionCwd
    /// A fixed folder on the host, so media doesn't land in whatever repo the shell is in.
    case uploads
  }

  /// SCP-sends to the destination, falling back to the live cwd if the uploads folder
  /// can't be resolved. Returns the remote path.
  @discardableResult
  public func sendFile(data: Data, filename: String, to destination: SendDestination = .sessionCwd) async -> String? {
    var dir: String?
    if destination == .uploads {
      let out = try? await control.exec(MediaTransfer.uploadsDirectoryCommand)
      dir = MediaTransfer.uploadsDirectory(fromOutput: out)
    }
    if dir == nil { dir = await currentCwd() }
    let remote = MediaTransfer.remotePath(directory: dir, filename: filename)
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
      let remote = await sendFile(data: data, filename: name, to: .uploads)
      // Typed keystrokes stay a raw path; only a paste makes a TUI attach the image.
      if let remote { sendPaste(shellQuote(remote)) }
    case let .failed(message):
      reportTransferFailure(message)
    }
  }

  /// A transfer that failed before any SSH work reuses the upload banner.
  private func reportTransferFailure(_ message: String) { transfer = .failed(message) }

  public func loadGitWorkspace(payload: GitWorkspacePayload = .all) async {
    if let running = gitLoads[payload] {
      await running.value
      return
    }
    let load = Task { await performGitLoad(payload) }
    gitLoads[payload] = load
    await load.value
    gitLoads[payload] = nil
  }

  private func performGitLoad(_ payload: GitWorkspacePayload) async {
    gitLoading = true
    defer { gitLoading = false }
    switch payload {
    case .all:
      async let local: Void = loadLocalGit(diff: true, commits: true)
      async let remote: Void = loadPullRequests()
      _ = await (local, remote)
    case .changes: await loadLocalGit(diff: true, commits: false)
    case .commits: await loadLocalGit(diff: false, commits: true)
    case .pullRequests: await loadPullRequests()
    }
  }

  /// A failed refresh keeps what is on screen and says why: clearing it made a dropped
  /// connection read as "no uncommitted changes".
  private func loadLocalGit(diff: Bool, commits: Bool) async {
    let knownHead = gitCommits.isEmpty ? nil : gitHead
    let read: GitWorkspaceRead
    do {
      guard let result = try await execInSessionCwd(
        GitWorkspaceScript.workspace(diff: diff, commits: commits, knownHead: knownHead))
      else {
        setGitError("No working directory for this session.")
        return
      }
      read = await Task.detached { GitWorkspaceScript.parse(cwd: result.cwd, result.output) }.value
    } catch {
      setGitError(Self.describe(error))
      return
    }
    switch read {
    case .unreadable:
      setGitError("Could not read the git workspace.")
    case let .notRepository(cwd):
      clearGitWorkspace()
      setGitError("Not a git repository:\n\(cwd)")
    case let .repository(sections):
      setGitError(nil)
      if gitCwd != sections.cwd {
        gitCwd = sections.cwd
        gitRawDiff = nil
        gitHead = nil
      }
      if gitBranch != sections.branch { gitBranch = sections.branch }
      if diff {
        if gitRawDiff != sections.diff {
          gitRawDiff = sections.diff
          let raw = sections.diff
          let files = await Task.detached { DiffFile.group(GitDiffModel.classify(raw)) }.value
          if gitFiles != files { gitFiles = files }
        }
        if gitUntracked != sections.untracked { gitUntracked = sections.untracked }
        if gitUntrackedTruncated != sections.untrackedTruncated { gitUntrackedTruncated = sections.untrackedTruncated }
        if gitDiffTruncated != sections.diffTruncated { gitDiffTruncated = sections.diffTruncated }
      }
      if commits, case let .list(head, list) = sections.commits {
        gitHead = head
        if gitCommits != list { gitCommits = list }
      }
    }
  }

  private func loadPullRequests() async {
    let result: GitRepositoryModel.PullRequestResult
    do {
      guard let output = try await execInSessionCwd(GitWorkspaceScript.pullRequests, on: ghControl)?.output else {
        return
      }
      result = GitRepositoryModel.pullRequestResult(from: output)
    } catch {
      result = .failed(Self.describe(error))
    }
    switch result {
    case let .list(pulls):
      if gitPullRequests != pulls { gitPullRequests = pulls }
      gitPullRequestNotice = nil
    case .toolMissing:
      gitPullRequests = []
      gitPullRequestNotice = "GitHub CLI isn't installed on this host."
    case let .failed(reason):
      // A list already on screen stays; the notice only explains an empty one.
      if gitPullRequests.isEmpty { gitPullRequestNotice = reason }
    }
    gitPullRequestsLoaded = true
  }

  private func setGitError(_ error: String?) {
    if gitError != error { gitError = error }
  }

  private func clearGitWorkspace() {
    gitFiles = []
    gitUntracked = []
    gitUntrackedTruncated = false
    gitDiffTruncated = false
    gitBranch = ""
    gitCommits = []
    gitPullRequests = []
    gitPullRequestNotice = nil
    gitRawDiff = nil
    gitHead = nil
  }

  /// Runs `command` in the attached shell's working directory, resolved on the host in the
  /// same exec. nil when the session has no directory to run in.
  private func execInSessionCwd(
    _ command: String, on connection: ControlConnection? = nil
  ) async throws -> (cwd: String, output: String)? {
    for attempt in 0..<2 {
      guard let enter = await sessionCwdScript(refreshing: attempt > 0) else { return nil }
      let output = try await (connection ?? control).exec(enter + command)
      if let split = GitWorkspaceScript.splitCwd(output) { return split }
    }
    return nil
  }

  /// The `cd` prefix for the attached session. A stale pid falls back to the directory the
  /// shell last reported; when that fails too, a second try reads a fresh `zmx ls`.
  private func sessionCwdScript(refreshing: Bool, announce: Bool = true) async -> String? {
    if refreshing || !sessions.contains(where: { $0.name == attach }) { await refreshSessions() }
    guard let session = sessions.first(where: { $0.name == attach }) else { return nil }
    let fallback = terminalReport.cwd ?? (session.displayCwd.hasPrefix("/") ? session.displayCwd : nil)
    return GitWorkspaceScript.enterCwd(pid: session.pid, fallback: fallback, announce: announce)
  }

  /// An untracked file's contents as an all-added patch.
  public func untrackedDiff(_ path: String) async -> GitPatch {
    guard let raw = try? await execInSessionCwd(GitWorkspaceScript.untrackedDiff(path))?.output else { return .empty }
    return await GitPatch.parse(raw)
  }

  /// Its own dial keeps the long-lived watch off the serial control connection. False when the
  /// dial failed, so the caller falls back rather than assume the checks are done.
  public func streamChecks(
    _ pullRequest: GitPullRequest,
    onSnapshot: @escaping @MainActor ([GitCheck]) -> Void
  ) async -> Bool {
    guard let enter = await sessionCwdScript(refreshing: false, announce: false) else { return false }
    let command = enter + "gh pr checks \(pullRequest.number) --watch --interval 15 2>&1"
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
    let prView = "gh pr view \(pullRequest.number) --json statusCheckRollup,body,mergeable,mergeStateStatus,isDraft,state 2>/dev/null"
    let repoView = "gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed 2>/dev/null"
    guard let raw = try? await execInSessionCwd("{ \(prView); printf '\\036'; \(repoView); }", on: ghControl)?.output
    else { return .empty }
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

  /// One commit's patch, kept apart from `gitFiles` so opening a commit does not replace the
  /// working-tree diff behind it. A commit never changes, so its patch is read once.
  public func commitDiff(_ commit: GitCommit) async -> GitPatch {
    let key = "\(gitCwd ?? "")\u{1F}\(commit.id)"
    if let cached = commitPatches[key] { return cached }
    guard let raw = try? await execInSessionCwd(GitWorkspaceScript.commitDiff(commit.id))?.output else {
      return .empty
    }
    let patch = await GitPatch.parse(raw, splittingCommitMessage: true)
    if commitPatches.count >= 32 { commitPatches.removeAll() }
    commitPatches[key] = patch
    return patch
  }

  /// The pull request's own patch. Reused for a minute: reopening it right away is the
  /// common case, and a push in between is rare enough to wait for.
  public func pullRequestDiff(_ pullRequest: GitPullRequest) async -> GitPatch {
    if let cached = pullRequestPatches[pullRequest.number], clock().timeIntervalSince(cached.at) < 60 {
      return cached.patch
    }
    guard let raw = try? await execInSessionCwd(GitWorkspaceScript.pullRequestDiff(pullRequest.number), on: ghControl)?.output
    else { return .empty }
    let patch = await GitPatch.parse(raw)
    pullRequestPatches[pullRequest.number] = (patch, clock())
    return patch
  }

  public func checkoutPullRequest(_ pullRequest: GitPullRequest) async {
    let branch = shellQuote("tether/pr/\(pullRequest.number)")
    await runGitAction(
      "Checking out #\(pullRequest.number)…",
      "git fetch origin pull/\(pullRequest.number)/head:\(branch) && git switch \(branch)",
      reload: .changes)
  }

  public func updatePullRequest(_ pullRequest: GitPullRequest) async {
    let branch = shellQuote("tether/pr/\(pullRequest.number)")
    await runGitAction(
      "Updating #\(pullRequest.number)…", "git fetch origin pull/\(pullRequest.number)/head:\(branch)",
      reload: .changes)
  }

  public func closePullRequest(_ pullRequest: GitPullRequest) async {
    await runGitAction("Closing #\(pullRequest.number)…", "gh pr close \(pullRequest.number)", reload: .pullRequests)
  }

  @discardableResult
  public func mergePullRequest(_ pullRequest: GitPullRequest, method: GitMergeMethod) async -> Bool {
    await runGitAction(
      "Merging #\(pullRequest.number)…", "gh pr merge \(pullRequest.number) \(method.flag)", reload: .pullRequests)
  }

  /// Reloads only what the action changed: a full reload waited on `gh pr list` too.
  @discardableResult
  private func runGitAction(_ message: String, _ command: String, reload: GitWorkspacePayload) async -> Bool {
    gitActionMessage = message
    do {
      guard try await execInSessionCwd(command, on: ghControl) != nil else {
        gitActionMessage = "No working directory for this session."
        return false
      }
      gitActionMessage = nil
      await loadGitWorkspace(payload: reload)
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
    await suspendNow(flushingPush: true)
  }

  /// Starts `tether-notify flush` detached on the host and returns at once: it waits there for
  /// the attach client to be gone, then sends the push the host skipped while this phone was
  /// attached. A missing `tether-notify` is not an error.
  nonisolated static func flushPushCommand(session: String) -> String {
    "command -v \(notify) >/dev/null && { nohup \(notify) flush --session \(shellQuote(session)) >/dev/null 2>&1 </dev/null & }"
  }

  private static let flushPushTimeout: TimeInterval = 2

  /// Bounds only the exec round trip; the flush itself outlives the connection.
  private func flushPush(session: String) async {
    let control = control
    let command = Self.flushPushCommand(session: session)
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let once = ResumeOnce(continuation)
      Task {
        _ = try? await control.exec(command)
        once.resume()
      }
      Task {
        try? await Task.sleep(nanoseconds: UInt64(Self.flushPushTimeout * 1_000_000_000))
        once.resume()
      }
    }
  }

  /// For a session this phone is leaving while the connection stays up.
  private func flushPushInBackground(session: String) {
    Task { await flushPush(session: session) }
  }

  public func suspendNow(flushingPush: Bool = false) async {
    guard !left, !isSuspended else { return }
    isSuspended = true
    status = .disconnected
    let session = attach
    await pipeline.disconnect()
    // Foregrounded meanwhile: the redial owns the control connection now.
    guard isSuspended, !left else { return }
    if flushingPush && hasSession { await flushPush(session: session) }
    guard isSuspended, !left else { return }
    await control.close()
    if ghControl !== control { await ghControl.close() }
  }

  public func enterForeground() async {
    guard questionSession != attach else { return }
    isSuspended = false
    await reconnectIfNeeded()
  }

  /// The session whose held question the answer sheet is answering. Attaching it would
  /// hand the question back to the terminal, so the foreground redial waits for the sheet.
  private var questionSession: String?

  /// Answer… brings the app forward before its response arrives, so a redial may already
  /// be under way: suspending now stops it before it attaches.
  public func beginAnsweringQuestion(in session: String) async {
    questionSession = session
    guard session == attach else { return }
    await suspendNow(flushingPush: true)
  }

  public func finishAnsweringQuestion() async {
    guard let session = questionSession else { return }
    questionSession = nil
    if session == attach { await enterForeground() }
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
    if !hasSettledGrid { lastCols = cols; lastRows = rows }
    pipeline.outbound.yield(.localResize(cols: cols, rows: rows))
  }
  public func updateGridServer(cols: UInt16, rows: UInt16) {
    hasSettledGrid = true
    lastCols = cols; lastRows = rows
    pipeline.outbound.yield(.serverResize(cols: cols, rows: rows))
  }
  public func scroll(lines: Int32) { Task { await pipeline.scrollViewport(lines: lines) } }
  public func updateCellPixelSize(width: Int, height: Int) {
    Task { await pipeline.setCellPixelSize(width: width, height: height) }
  }
  public func jumpToPrompt(_ direction: PromptJump) async -> Bool { await pipeline.jumpToPrompt(direction) }
  public func lastCommandOutput() async -> String? { await pipeline.lastCommandOutput() }
  /// Numbered here, synchronously, so the pipeline can drop a request that reaches it
  /// after a newer one, however the tasks carrying them are scheduled.
  public func requestTheme(_ theme: TerminalTheme) {
    themeSequence += 1
    let sequence = themeSequence
    Task { await pipeline.setTheme(theme, sequence: sequence) }
  }
  public func leave() async {
    left = true
    stopNetworkWatch()
    // Terminal first: the control queue may be held by a command on a dead path.
    await pipeline.disconnect()
    if !isSuspended && hasSession { await flushPush(session: attach) }
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
    case .bell:
      guard appIsActive(), bellThrottle.shouldRing(at: ProcessInfo.processInfo.systemUptime) else { return }
      bellRings += 1
    case let .report(report):
      terminalReport = report
    case let .clipboard(text):
      guard appIsActive() else { return }
      writeClipboard(text)
    case .error:
      markDisconnectedAndReconnect()
    }
  }

  /// Never fires on an intentional leave: the pipeline cancels its read task, which suppresses
  /// the error.
  private func markDisconnectedAndReconnect() {
    guard let next = Self.statusAfterTransportDrop(from: status) else { return }
    status = next
    // Nothing will finish the job the bar was showing.
    terminalReport.progress = nil
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

private final class ResumeOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?

  init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }

  func resume() {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume()
  }
}
