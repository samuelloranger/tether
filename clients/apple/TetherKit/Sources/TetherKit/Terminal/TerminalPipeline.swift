import Foundation
import TetherFFIBindings

/// Everything the pipeline tells the store that is not a grid.
///
/// Kept separate from the snapshot stream on purpose: snapshots are allowed to
/// be dropped when the main actor falls behind (only the newest one matters),
/// and these are not.
public enum TerminalPipelineEvent: Sendable {
  case mouseModes(mode: MouseMode, sgr: Bool)
  /// A `title`/`activity`/`exit` frame — the session list is out of date.
  case sessionsChanged
  case error(String)
}

/// A frame the UI wants on the wire, in the order the UI produced it.
///
/// These go through a stream rather than through `await pipeline.send…`: a
/// `Task { await … }` per keystroke has NO defined enqueue order, so fast
/// typing could reach the socket out of order. `AsyncStream.Continuation.yield`
/// is FIFO and callable without awaiting, which is exactly what a key handler
/// needs.
enum OutboundFrame: Sendable {
  /// `key` is the HOST-QUALIFIED session the text was typed INTO. The pump is
  /// a separate task from `connectNoise`/`disconnect`, so a frame queued just
  /// before a session switch can be handled after the socket has already been
  /// replaced — without this, the tail of what you typed into one terminal
  /// would be sent to the next one.
  case input(String, key: String?)
  case paste(String, key: String?)
  case focus(Bool)
  case resize(cols: UInt16, rows: UInt16)
}

/// Owns the Noise session channel and the VT emulator, off the main actor.
///
/// The whole read path used to be `@MainActor` (it lived on `SessionStore`), so
/// every output frame charged the main thread for a JSON parse, a Rust VT feed,
/// a full-grid snapshot copy, and a SwiftUI invalidation. Under a chatty
/// program that saturated the run loop and the UI stopped answering touches —
/// the drawer took seconds to open. Everything here runs on the actor's own
/// executor instead; the main actor only receives the newest grid.
actor TerminalPipeline {
  /// Newest-wins: if the main actor is busy, intermediate grids are dropped
  /// rather than queued. A terminal only ever needs to draw the latest state.
  /// `nil` means "clear the surface".
  nonisolated let snapshots: AsyncStream<Data?>
  nonisolated let events: AsyncStream<TerminalPipelineEvent>
  /// Callable from any isolation without awaiting — see `OutboundFrame`.
  nonisolated let outbound: AsyncStream<OutboundFrame>.Continuation

  private let snapshotSink: AsyncStream<Data?>.Continuation
  private let eventSink: AsyncStream<TerminalPipelineEvent>.Continuation
  private let outboundFrames: AsyncStream<OutboundFrame>

  private let replayStore = FfiReplayStore()
  private var emulator: FfiTerminalEmulator?
  /// Which HOST-QUALIFIED session key `emulator` holds the scrollback for.
  private var emulatorKey: String?
  /// Live Noise transport. `connectNoise` calls `disconnect()` first; the
  /// outbound pump routes to this channel when it is set.
  private var noiseChannel: NoiseChannel?
  /// The session id `sendStart` was issued for — every Noise input/resize frame
  /// carries it.
  private var noiseSessionId: String?
  private var noiseReadTask: Task<Void, Never>?
  private var outboundTask: Task<Void, Never>?
  private var lastTrafficMs: Int64 = 0
  private var lastRenderedGeneration: UInt64?
  private var lastFocusSent: Bool?
  private var lastMouseMode: MouseMode = .off
  private var lastMouseSgr = true
  /// One source of truth for the grid size: the channel, the parser and any
  /// later resize must agree or the rendered grid will not match the PTY.
  private var cols: UInt16 = 80
  private var rows: UInt16 = 24

  init() {
    (snapshots, snapshotSink) = AsyncStream.makeStream(
      of: Optional<Data>.self,
      bufferingPolicy: .bufferingNewest(1)
    )
    (events, eventSink) = AsyncStream.makeStream(of: TerminalPipelineEvent.self)
    (outboundFrames, outbound) = AsyncStream.makeStream(of: OutboundFrame.self)
  }

  // MARK: - Connection

  /// Establishes a Noise session and pumps it into the emulator/snapshot sink.
  /// The outbound pump routes input/resize to `noiseChannel` once it is set.
  ///
  /// The server replays a session's whole retained tail in response to `start`
  /// (`subscribeToSession`), so there is no `sinceId` cursor: the emulator is
  /// always rebuilt fresh and refilled from that replay.
  ///
  /// Reduced-robustness TODOs for a later pass:
  ///   - No auto-reconnect/backoff. An unexpected drop surfaces an error; the
  ///     next foreground resume (or a manual reselect) re-runs `reconnect` +
  ///     `sendStart`.
  ///   - No replay de-dup guard (relies on the fresh-emulator + full-replay
  ///     model above).
  func connectNoise(
    client: NoiseSessionClient,
    hostId: String,
    url: URL,
    sessionId: String,
    key: String
  ) async {
    disconnect()
    startOutboundPumpIfNeeded()
    // Always a fresh grid: the server replays the whole tail on `start`.
    emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    emulatorKey = key
    lastRenderedGeneration = nil
    snapshotSink.yield(nil)
    resetMouseModes()
    do {
      let channel = try await client.reconnect(hostId: hostId, url: url)
      try await channel.sendStart(id: sessionId, cols: cols, rows: rows)
      noiseChannel = channel
      noiseSessionId = sessionId
      noteTraffic()
      noiseReadTask = Task { [weak self] in
        await self?.readLoopNoise(key: key, channel: channel)
      }
    } catch {
      eventSink.yield(.error(error.localizedDescription))
    }
  }

  private func readLoopNoise(key: String, channel: NoiseChannel) async {
    while !Task.isCancelled {
      do {
        let message = try await channel.receive()
        // Stale channel: the active terminal moved on since this opened.
        guard key == emulatorKey else { continue }
        noteTraffic()
        switch message {
        case let .output(_, chunk):
          if let bytes = chunk.data(using: .utf8) {
            emulator?.feed(bytes: bytes)
            publishSnapshot()
          }
        case .exit:
          eventSink.yield(.sessionsChanged)
        case .devices, .devicesRevoked, .authToken:
          // Device-management and auth-token replies never ride the terminal
          // channel; they are driven over their own short-lived sessions
          // (`DevicesView`, `NoiseTokenCache`). Ignore.
          break
        }
      } catch {
        // A deliberate teardown cancels this task; anything else is an
        // unexpected drop. No backoff here (see `connectNoise` TODOs) — just
        // report it so the UI can reflect a closed connection.
        if !Task.isCancelled {
          eventSink.yield(.error("Connection closed"))
        }
        break
      }
    }
  }

  /// Drops the channel but KEEPS the emulator — this runs at the top of every
  /// `connectNoise`, so clearing it here would defeat scrollback reuse on a
  /// foreground reconnect.
  func disconnect() {
    sendFocus(focused: false)
    lastFocusSent = nil
    noiseReadTask?.cancel()
    noiseReadTask = nil
    if let channel = noiseChannel {
      noiseChannel = nil
      noiseSessionId = nil
      Task { await channel.close() }
    }
  }

  /// Leaves the terminal entirely, as opposed to reconnecting to the same
  /// session: the emulator and its scrollback go too.
  func release() {
    disconnect()
    emulator = nil
    emulatorKey = nil
    lastRenderedGeneration = nil
    snapshotSink.yield(nil)
    resetMouseModes()
  }

  func forget(key: String) {
    replayStore.forget(sessionId: key)
  }

  /// What to do with this channel after the app came back to the foreground.
  func resumeAction(nowMs: Int64) -> ResumeAction {
    ResumeLogic.action(open: noiseChannel != nil, lastSeenMs: lastTrafficMs, nowMs: nowMs)
  }

  // MARK: - Local emulator control

  /// Scrolls the local VT viewport through scrollback (not PTY PgUp/PgDn).
  /// Positive `lines` moves into history; negative toward the live bottom.
  func scrollViewport(lines: Int32) {
    guard lines != 0, let emulator else { return }
    emulator.scrollViewport(lines: lines)
    publishSnapshot()
  }

  // MARK: - Outbound

  private func startOutboundPumpIfNeeded() {
    guard outboundTask == nil else { return }
    let frames = outboundFrames
    outboundTask = Task { [weak self] in
      for await frame in frames {
        await self?.handleOutbound(frame)
      }
    }
  }

  private func handleOutbound(_ frame: OutboundFrame) async {
    // `focus` has no Noise frame — the server treats a Noise client as the sole,
    // always-focused viewer of its session.
    guard let channel = noiseChannel, let id = noiseSessionId else { return }
    switch frame {
    case let .input(text, key):
      guard stillCurrent(key) else { return }
      try? await channel.sendInput(id: id, text: text)
    case let .paste(text, key):
      guard stillCurrent(key) else { return }
      try? await channel.sendInput(id: id, text: emulator?.pastePayload(text: text) ?? text)
    case .focus:
      break
    case let .resize(newCols, newRows):
      if applyLocalResize(cols: newCols, rows: newRows) {
        try? await channel.sendResize(id: id, cols: newCols, rows: newRows)
      }
    }
  }

  /// Whether a queued frame still belongs to the terminal on screen.
  ///
  /// Dropping the tail of a switched-away-from session is the safe half of the
  /// trade; delivering it to the session that replaced it is not.
  private func stillCurrent(_ key: String?) -> Bool {
    guard let key else { return true }
    return key == emulatorKey
  }

  /// Resizes the LOCAL emulator and records the new grid size. Returns whether
  /// the size actually changed, so the caller only puts a resize frame on the
  /// wire when it did.
  @discardableResult
  private func applyLocalResize(cols newCols: UInt16, rows newRows: UInt16) -> Bool {
    guard newCols != cols || newRows != rows else { return false }
    cols = newCols
    rows = newRows
    emulator?.resize(cols: newCols, rows: newRows)
    publishSnapshot()
    return true
  }

  /// Tracks the last focus value so `.inactive` then `.background` for one
  /// scenePhase transition is not treated as two events. Noise has no focus
  /// frame — the server treats a Noise client as always-focused.
  func sendFocus(focused: Bool) {
    lastFocusSent = focused
  }

  // MARK: - Publishing

  /// Publishes a new grid only when the visible contents actually changed.
  ///
  /// `generation` is why this is cheap: it is compared before pulling the
  /// packed bytes, so a burst of output that does not alter the viewport costs
  /// nothing beyond the counter read.
  private func publishSnapshot() {
    guard let emulator else { return }
    let generation = emulator.generation()
    // Mouse mode can flip without a viewport change (e.g. vim entering or
    // leaving mouse tracking). Keep the surface's input path in sync either way.
    syncMouseModes(from: emulator)
    guard generation != lastRenderedGeneration else { return }
    lastRenderedGeneration = generation
    snapshotSink.yield(emulator.snapshot())
  }

  private func syncMouseModes(from emulator: FfiTerminalEmulator) {
    let mode = MouseMode(rawValue: emulator.mouseMode()) ?? .off
    let sgr = emulator.mouseSgr()
    guard mode != lastMouseMode || sgr != lastMouseSgr else { return }
    lastMouseMode = mode
    lastMouseSgr = sgr
    eventSink.yield(.mouseModes(mode: mode, sgr: sgr))
  }

  private func resetMouseModes() {
    lastMouseMode = .off
    lastMouseSgr = true
    eventSink.yield(.mouseModes(mode: .off, sgr: true))
  }

  private func noteTraffic() {
    lastTrafficMs = Int64(Date().timeIntervalSince1970 * 1000)
  }
}
