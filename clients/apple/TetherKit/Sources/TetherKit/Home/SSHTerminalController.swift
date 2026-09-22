import Foundation
import TetherFFIBindings

/// Drives one SSH-backed terminal: connect via `SSHConnector`, pump the PTY
/// through a `TerminalPipeline` into the shared renderer, and attach to a zmx
/// session so the shell survives disconnects.
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
    /// The transport dropped under a live session (iOS suspended the socket, a
    /// GOAWAY, a network blip). Distinct from `.failed` so the UI shows a calm
    /// "reconnecting" state, and so every reconnect gate (which only skips when
    /// `.connected`) actually redials instead of trusting a stale `.connected`.
    case disconnected
    case failed(String)
  }

  /// What the terminal overlay says while there is no live session. Text plus
  /// an icon — connection state is never carried by colour alone.
  public struct ConnectionCopy: Equatable {
    public var message: String
    public var icon: String
    public var showsRetry: Bool
  }

  public enum TransferState: Equatable {
    case idle
    case sending(String)
    case sent(String)
    case failed(String)
  }

  public static let defaultAttach = "default"

  public var snapshot: Data?
  public private(set) var status: Status = .connecting
  public private(set) var mouseMode: MouseMode = .off
  public private(set) var mouseSgr = true
  public let title: String
  public private(set) var sessionKey: String
  public private(set) var sessions: [ZmxSession] = []
  public private(set) var attach: String
  /// False when we connected to a host that had no zmx sessions: the PTY is a
  /// bare login shell and no session was auto-created. The UI shows an
  /// empty-state prompt until the user creates one.
  public private(set) var hasSession = true
  public private(set) var gitLines: [GitDiffLine] = []
  public private(set) var gitFiles: [DiffFile] = []
  public private(set) var gitBranch = ""
  public private(set) var gitCommits: [GitCommit] = []
  public private(set) var gitPullRequests: [GitPullRequest] = []
  /// Why the list is empty, when the reason is not "none open".
  public private(set) var gitPullRequestNotice: String?
  public private(set) var gitChecks: [GitCheck] = []
  public private(set) var gitChecksUpdatedAt: Date?
  public private(set) var gitChecksLoading = false
  public private(set) var gitPullRequestBody = ""
  public private(set) var gitUpdatedAt: Date?
  public private(set) var gitError: String?
  public private(set) var gitActionMessage: String?
  public private(set) var gitLoading = false
  public private(set) var transfer: TransferState = .idle
  public private(set) var reachability: NetworkReachability?

  private let pathObserver = NetworkPathObserver()
  /// Opened lazily on first use, which is always after the terminal connects.
  private let control: ControlConnection
  private static let zmx = "~/.local/bin/zmx"
  private static let notify = "~/.local/bin/tether-notify"
  private let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
  private let config: SSHConnectionConfig
  private let hostKeyStore: HostKeyStore
  private let pushIdentity: PushRegistrar.PushIdentity?
  private var didRegisterPush = false
  private var connectInFlight = false
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
    pushIdentity: PushRegistrar.PushIdentity? = nil
  ) {
    self.title = title
    self.config = config
    self.hostKeyStore = hostKeyStore
    self.attach = attach
    self.pushIdentity = pushIdentity
    self.control = ControlConnection(config: config, store: hostKeyStore)
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

  public func connect() async {
    // Serialize: the initial .task connect and a scenePhase .active reconnect can
    // both fire before the first is `.connected`, otherwise double-attaching.
    if connectInFlight { return }
    connectInFlight = true
    defer { connectInFlight = false }
    status = .connecting
    // Release any live session before dialing. A redial-driven switch (alt-screen)
    // gets here with the previous pump still running; dialing and authenticating a
    // second connection alongside it made auth fail until a force-quit killed the
    // old one. connectSSH also disconnects, but only after the new auth succeeds —
    // too late. No-op on a cold connect or a post-drop reconnect (no live transport).
    await pipeline.disconnect()
    await chooseInitialSessionIfNeeded()
    // The key is valid; libssh2 auth/transport occasionally fails transiently
    // (and the app opens a couple of connections at once), so retry a few times.
    // A host-key mismatch is never retried — that must fail loudly.
    for attempt in 0..<3 {
      do {
        let stream = try await SSHConnector.connect(config: config, store: hostKeyStore)
        await pipeline.connectSSH(transport: stream, key: sessionKey)
        status = .connected
        // The fresh PTY is 80x24 and the surface bounds don't change on a session
        // switch, so it never re-reports — push the last known size now (SIGWINCH)
        // so the newly attached session reflows to the device.
        pipeline.outbound.yield(.serverResize(cols: lastCols, rows: lastRows))
        // Zero-session host: leave the bare login shell, don't auto-create.
        // The UI shows an empty-state prompt until the user starts one.
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

  /// On the first connect, attach to an existing session instead of forcing a
  /// new "default": only create "default" when the host has no sessions at all.
  /// An explicit target (a switch, or the launch-env attach) is left alone.
  private func chooseInitialSessionIfNeeded() async {
    guard !didChooseInitialSession else { return }
    didChooseInitialSession = true
    guard attach == Self.defaultAttach else { return }
    guard let out = try? await control.exec("\(Self.zmx) ls") else { return }
    let existing = ZmxSession.parse(out)
    // No sessions at all → don't create "default"; land on the empty state.
    if existing.isEmpty { pendingNoSession = true; return }
    // A host with a "default" already: attach it. Otherwise attach the newest.
    guard !existing.contains(where: { $0.name == Self.defaultAttach }) else { return }
    attach = existing.max(by: { $0.created < $1.created })?.name ?? attach
  }

  /// Best-effort: tell the host's tether-notify about this device once per
  /// connection. Delayed so its extra SSH connection doesn't race the terminal
  /// handshake. Never blocks or fails the shell.
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
        if !parsed.isEmpty || attempt == 2 { sessions = parsed; return }
      }
      try? await Task.sleep(nanoseconds: 400_000_000)
    }
  }

  /// Detaches whatever zmx client holds the PTY and attaches the new session on
  /// the shell underneath, so the program running in the session we leave — a
  /// CLI agent mid-task — is never typed into and keeps running on the host.
  public func switchSession(to name: String) async {
    // Skip only when it's the same session we're already on. When there is no
    // session yet (empty-state host), attach even if the name equals `attach`.
    guard name != attach || !hasSession else { return }
    let wasAttached = hasSession
    attach = name
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

  /// Live working directory of the current session's shell. `zmx ls` only
  /// reports the login dir, so read the shell pid's `/proc/<pid>/cwd`; falls
  /// back to the reported dir when `/proc` is unavailable.
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
      do {
        try await SSHConnector.scpSend(config: config, store: hostKeyStore, data: data, remotePath: remote)
      } catch where Self.shouldRetryTransfer(after: error) {
        try await SSHConnector.scpSend(config: config, store: hostKeyStore, data: data, remotePath: remote)
      }
      transfer = .sent(remote)
      return remote
    } catch {
      transfer = .failed(Self.describe(error))
      return nil
    }
  }

  public func clearTransfer() { transfer = .idle }

  /// A transfer that failed before any SSH work reuses the upload banner.
  public func reportTransferFailure(_ message: String) { transfer = .failed(message) }

  /// A changed host key and a missing credential are answers, not noise:
  /// repeating them only delays telling the user.
  nonisolated static func shouldRetryTransfer(after error: Error) -> Bool {
    switch error as? SSHConnectError {
    case .hostKeyMismatch, .missingCredential: return false
    default: return true
    }
  }

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
    // The sentinel marks "not a repo" — an empty diff is a valid, distinct
    // result.
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
      pullRequestsCommand = "if command -v gh >/dev/null 2>&1; then (cd \(q) && gh pr list --state open --limit 50 --json number,title,headRefName,baseRefName,url,updatedAt,isDraft,changedFiles,reviewDecision 2>&1); else printf '%s' \(ghMissing); fi"
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
      gitUpdatedAt = Date()
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
      }
    } catch {
      gitLines = []
      gitFiles = []
      gitError = Self.describe(error)
    }
  }

  /// Checks and description for one pull request, in a single round trip.
  public func loadPullRequestDetail(_ pullRequest: GitPullRequest) async {
    gitChecksLoading = true
    defer { gitChecksLoading = false }
    guard let cwd = await currentCwd() else { return }
    let command = "cd \(shellQuote(cwd)) && gh pr view \(pullRequest.number) --json statusCheckRollup,body 2>/dev/null"
    guard let raw = try? await control.exec(command),
      let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
    else {
      gitChecksUpdatedAt = Date()
      return
    }
    if let rollup = object["statusCheckRollup"],
      let encoded = try? JSONSerialization.data(withJSONObject: rollup) {
      gitChecks = GitRepositoryModel.checks(from: String(decoding: encoded, as: UTF8.self))
    }
    gitPullRequestBody = (object["body"] as? String) ?? ""
    gitChecksUpdatedAt = Date()
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

  private func runGitAction(_ message: String, command: (String) -> String) async {
    gitActionMessage = message
    guard let cwd = await currentCwd() else { gitActionMessage = "No working directory for this session."; return }
    do {
      _ = try await control.exec(command(cwd))
      gitActionMessage = nil
      await loadGitWorkspace()
    } catch { gitActionMessage = Self.describe(error) }
  }

  /// Foreground-redial: never reuse a socket iOS may have killed while suspended.
  /// Shares the gate with the path observer so the two triggers can't race.
  public func reconnectIfNeeded() async {
    guard Self.shouldRedialOnForeground(status: status, dialing: connectInFlight, reachability: reachability) else { return }
    await connect()
  }

  /// Watch the network path for this screen. Redials only when a path *becomes*
  /// usable — a usable path is a route, never proof the host answered.
  public func startNetworkWatch() {
    pathObserver.start { [weak self] value in self?.pathChanged(value) }
  }

  public func stopNetworkWatch() { pathObserver.stop() }

  private func pathChanged(_ value: NetworkReachability) {
    let previous = reachability
    reachability = value
    guard Self.shouldRedial(previous: previous, next: value, status: status, dialing: connectInFlight) else { return }
    Task { await connect() }
  }

  /// The one network-driven recovery decision. Only an edge into a usable path
  /// counts: the monitor re-reports the same path on every interface change.
  nonisolated static func shouldRedial(
    previous: NetworkReachability?, next: NetworkReachability, status: Status, dialing: Bool
  ) -> Bool {
    guard next.isUsable, previous?.isUsable != true else { return false }
    return shouldRedialOnForeground(status: status, dialing: dialing, reachability: next)
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
      return ConnectionCopy(message: "Connecting…", icon: "antenna.radiowaves.left.and.right", showsRetry: false)
    case let .failed(message):
      return ConnectionCopy(message: message, icon: "exclamationmark.triangle", showsRetry: true)
    case .disconnected:
      switch reachability?.availability {
      case .offline:
        return ConnectionCopy(message: "Waiting for a network connection", icon: "wifi.slash", showsRetry: false)
      case .requiresConnection:
        return ConnectionCopy(message: "Network needs a connection", icon: "exclamationmark.triangle", showsRetry: false)
      case .usable, nil:
        return ConnectionCopy(message: "Connection lost — reconnecting…", icon: "arrow.clockwise", showsRetry: false)
      }
    }
  }

  /// Full session scrollback for the history screen. zmx runs a full-screen
  /// (alt-screen) session, so the local byte buffer only holds the current
  /// screen — `zmx history` is the real transcript. Falls back to the visible
  /// screen if the exec fails.
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
    stopNetworkWatch()
    await control.close()
    await pipeline.disconnect()
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
      // The transport died under a live session. Without this the status stayed
      // `.connected` and every reconnect gate skipped, so the terminal was dead
      // until the app was killed. Flip off `.connected` and redial.
      markDisconnectedAndReconnect()
    }
  }

  /// Flip a dropped session off `.connected` and kick a foreground redial. A no-op
  /// while a connect is already in flight, and never fires on an intentional
  /// leave (the pipeline cancels its read task, which suppresses the error).
  private func markDisconnectedAndReconnect() {
    guard let next = Self.statusAfterTransportDrop(from: status) else { return }
    status = next
    // A drop caused by the network dying must not spin on a dead path: the
    // observer redials the moment a usable one comes back.
    guard Self.shouldRedialOnForeground(status: next, dialing: connectInFlight, reachability: reachability) else { return }
    Task { await self.connect() }
  }

  /// Pure transition for a mid-session transport drop. `nil` leaves the status
  /// untouched — a reconnect is already underway (`.connecting`), so a late error
  /// from the old transport must not disturb it. Any settled state (crucially
  /// `.connected`, which used to be left stale) becomes `.disconnected` so the
  /// reconnect gates fire.
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
