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

  private static let zmx = "~/.local/bin/zmx"
  private let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
  private let config: SSHConnectionConfig
  private let hostKeyStore: HostKeyStore

  init(title: String, config: SSHConnectionConfig, hostKeyStore: HostKeyStore, attach: String = defaultAttach) {
    self.title = title
    self.config = config
    self.hostKeyStore = hostKeyStore
    self.attach = attach
    self.sessionKey = "ssh:\(config.host):\(config.port):\(attach)"
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
    do {
      let stream = try await SSHConnector.connect(config: config, store: hostKeyStore)
      await pipeline.connectSSH(transport: stream, key: sessionKey)
      status = .connected
      pipeline.outbound.yield(.input("\(Self.zmx) attach \(shellQuote(attach))\n", key: sessionKey))
    } catch {
      status = .failed(Self.describe(error))
    }
  }

  public func refreshSessions() async {
    if let output = try? await SSHConnector.exec(config: config, store: hostKeyStore, command: "\(Self.zmx) ls") {
      sessions = ZmxSession.parse(output)
    }
  }

  /// Switches zmx target by redialing fresh — hands the PTY to a new attach.
  public func switchSession(to name: String) async {
    guard name != attach else { return }
    await pipeline.disconnect()
    attach = name
    sessionKey = "ssh:\(config.host):\(config.port):\(name)"
    await connect()
  }

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

  public func sendInput(_ text: String) { pipeline.outbound.yield(.input(text, key: sessionKey)) }
  public func sendPaste(_ text: String) { pipeline.outbound.yield(.paste(text, key: sessionKey)) }
  public func updateGrid(cols: UInt16, rows: UInt16) { pipeline.outbound.yield(.localResize(cols: cols, rows: rows)) }
  public func updateGridServer(cols: UInt16, rows: UInt16) { pipeline.outbound.yield(.serverResize(cols: cols, rows: rows)) }
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
