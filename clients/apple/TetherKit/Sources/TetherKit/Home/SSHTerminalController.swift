import Foundation
import TetherFFIBindings

/// Drives one SSH-backed terminal: connect via the proven `SSHConnector`, pump
/// the PTY through a `TerminalPipeline` into the shared renderer, and attach to a
/// zmx session so the shell survives disconnects.
@MainActor
@Observable
public final class SSHTerminalController {
  public enum Status: Equatable {
    case connecting
    case connected
    case failed(String)
  }

  public var snapshot: Data?
  public private(set) var status: Status = .connecting
  public private(set) var mouseMode: MouseMode = .off
  public private(set) var mouseSgr = true
  public let title: String
  public let sessionKey: String

  private let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
  private let config: SSHConnectionConfig
  private let hostKeyStore: HostKeyStore
  private let attach: String

  init(title: String, config: SSHConnectionConfig, hostKeyStore: HostKeyStore, attach: String = "default") {
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
      // zmx attach is create-or-join, so the shell persists across redials.
      pipeline.outbound.yield(.input("~/.local/bin/zmx attach \(attach)\n", key: sessionKey))
    } catch {
      status = .failed(Self.message(for: error))
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

  private static func message(for error: Error) -> String {
    switch error {
    case let SSHConnectError.hostKeyMismatch(expected, got):
      return "Host key changed — refused.\nExpected \(expected)\nGot \(got)"
    case SSHConnectError.auth:
      return "Authentication failed. Check the key or password."
    case let SSHConnectError.transport(detail):
      return "Could not connect: \(detail)"
    default:
      return "Could not connect: \(error)"
    }
  }
}
