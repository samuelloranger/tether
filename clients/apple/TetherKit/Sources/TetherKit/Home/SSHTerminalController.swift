import Foundation
import TetherFFIBindings

/// Drives one SSH-backed terminal: connect via `SSHConnector`, pump the PTY
/// through a `TerminalPipeline` into the shared renderer, and attach to a zmx
/// session so the shell survives disconnects.
@MainActor
@Observable
public final class SSHTerminalController {
  public enum Status: Equatable {
    case connecting
    case connected
    case failed(String)
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
  public private(set) var gitLines: [GitDiffLine] = []
  public private(set) var gitError: String?
  public private(set) var gitLoading = false
  public private(set) var transfer: TransferState = .idle

  private static let zmx = "~/.local/bin/zmx"
  private static let notify = "~/.local/bin/tether-notify"
  private let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
  private let config: SSHConnectionConfig
  private let hostKeyStore: HostKeyStore
  private let pushIdentity: PushRegistrar.PushIdentity?
  private var didRegisterPush = false
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
    status = .connecting
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
        pipeline.outbound.yield(.input("\(Self.zmx) attach \(shellQuote(attach))\n", key: sessionKey))
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

  /// Best-effort: tell the host's tether-notify about this device once per
  /// connection. Delayed so its extra SSH connection doesn't race the terminal
  /// handshake. Never blocks or fails the shell.
  private func schedulePushRegister() {
    guard !didRegisterPush, let id = pushIdentity else { return }
    didRegisterPush = true
    let command = "\(Self.notify) register \(shellQuote(id.token)) \(shellQuote(id.secretKey)) \(shellQuote(id.label))"
    Task { [config, hostKeyStore] in
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      _ = try? await SSHConnector.exec(config: config, store: hostKeyStore, command: command)
    }
  }

  /// Retries when empty: a just-attached session can miss the first `zmx ls`
  /// (separate connection) before the daemon registers it.
  public func refreshSessions() async {
    for attempt in 0..<3 {
      if let output = try? await SSHConnector.exec(config: config, store: hostKeyStore, command: "\(Self.zmx) ls") {
        let parsed = ZmxSession.parse(output)
        if !parsed.isEmpty || attempt == 2 { sessions = parsed; return }
      }
      try? await Task.sleep(nanoseconds: 400_000_000)
    }
  }

  /// Switches over the live PTY: the attached shell carries `ZMX_SESSION`, so
  /// `zmx attach <name>` switches in place instead of redialing. No-op if a
  /// full-screen TUI holds the foreground.
  public func switchSession(to name: String) async {
    guard name != attach else { return }
    attach = name
    if case .connected = status {
      pipeline.outbound.yield(.input("\(Self.zmx) attach \(shellQuote(name))\n", key: sessionKey))
      await refreshSessions()
    } else {
      await connect()
    }
  }

  /// Switch away first when killing the current session — killing the one we're
  /// attached to would drop our own PTY.
  public func killSession(_ name: String) async {
    if name == attach {
      await refreshSessions()
      let next = sessions.first(where: { $0.name != name })?.name ?? Self.defaultAttach
      await switchSession(to: next)
    }
    _ = try? await SSHConnector.exec(config: config, store: hostKeyStore, command: "\(Self.zmx) kill \(shellQuote(name)) --force")
    await refreshSessions()
  }

  /// SCP-sends to the current session's cwd (home dir when cwd unknown).
  public func sendFile(data: Data, filename: String) async {
    if sessions.isEmpty { await refreshSessions() }
    let dir = sessions.first(where: { $0.name == attach })?.displayCwd
    let remote = dir?.hasPrefix("/") == true ? "\(dir!)/\(filename)" : filename
    transfer = .sending(filename)
    do {
      try await SSHConnector.scpSend(config: config, store: hostKeyStore, data: data, remotePath: remote)
      transfer = .sent(remote)
    } catch {
      transfer = .failed(Self.describe(error))
    }
  }

  public func clearTransfer() { transfer = .idle }

  public func loadGitDiff() async {
    gitLoading = true
    defer { gitLoading = false }
    gitError = nil
    if sessions.isEmpty { await refreshSessions() }
    guard let cwd = sessions.first(where: { $0.name == attach })?.displayCwd else {
      gitLines = []
      gitError = "No working directory for this session."
      return
    }
    do {
      let raw = try await SSHConnector.exec(
        config: config, store: hostKeyStore,
        command: "git -C \(shellQuote(cwd)) --no-pager diff 2>&1"
      )
      if raw.hasPrefix("fatal:") {
        gitLines = []
        gitError = raw.split(separator: "\n").first.map(String.init) ?? raw
      } else {
        gitLines = GitDiffModel.classify(raw)
        gitError = gitLines.isEmpty ? "No uncommitted changes in \(cwd)." : nil
      }
    } catch {
      gitLines = []
      gitError = Self.describe(error)
    }
  }

  /// Foreground-redial: never reuse a socket iOS may have killed while suspended.
  public func reconnectIfNeeded() async {
    if case .connected = status { return }
    await connect()
  }

  /// Full retained transcript as plain text (for the history screen).
  public func historyText() async -> String { await pipeline.historyText() }

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
  public func leave() async { await pipeline.disconnect() }

  private func apply(_ event: TerminalPipelineEvent) {
    if case let .mouseModes(mode, sgr) = event {
      mouseMode = mode
      mouseSgr = sgr
    }
  }

  private static func describe(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? "Could not connect: \(error)"
  }
}
