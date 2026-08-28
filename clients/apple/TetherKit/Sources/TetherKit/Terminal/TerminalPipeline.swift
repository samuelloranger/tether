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
  /// a separate task from `connect`/`disconnect`, so a frame queued just before
  /// a session switch can be handled after the socket has already been
  /// replaced — without this, the tail of what you typed into one terminal
  /// would be sent to the next one.
  case input(String, key: String?)
  case paste(String, key: String?)
  case focus(Bool)
  case resize(cols: UInt16, rows: UInt16)
}

/// Owns the session WebSocket and the VT emulator, off the main actor.
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
  private var socket: URLSessionWebSocketTask?
  private var socketIsOpen = false
  private var readTask: Task<Void, Never>?
  private var outboundTask: Task<Void, Never>?
  private var lastTrafficMs: Int64 = 0
  private var lastRenderedGeneration: UInt64?
  private var lastFocusSent: Bool?
  private var lastMouseMode: MouseMode = .off
  private var lastMouseSgr = true
  /// One source of truth for the grid size: the socket, the parser and any
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

  func connect(client: NativeHostClient, sessionId: String, key: String, focused: Bool) async {
    disconnect()
    startOutboundPumpIfNeeded()
    // Rebuilding the emulator while KEEPING the replay cursor throws away all
    // scrollback: an empty grid plus a cursor at the newest applied frame means
    // the server replays only what arrived since. Reuse it when reconnecting
    // the same session so `sinceId` resumes into the history it belongs to.
    if emulatorKey != key || emulator == nil {
      emulator = FfiTerminalEmulator(cols: cols, rows: rows)
      emulatorKey = key
      snapshotSink.yield(nil)
      resetMouseModes()
    }
    lastRenderedGeneration = nil
    let sinceId = replayStore.sinceId(sessionId: key)
    do {
      let task = try await client.openWebSocket(
        sessionId: sessionId,
        sinceId: sinceId,
        cols: cols,
        rows: rows
      )
      socket = task
      socketIsOpen = true
      noteTraffic()
      task.resume()
      // Fresh connection is focused unless the app is known to be backgrounded.
      sendFocus(focused: focused)
      // Capture the host-qualified key for this socket once. Re-deriving it
      // later races a host switch: a late frame from host A would key under B,
      // feed B's emulator, and advance B's replay cursor — which can silently
      // skip history.
      readTask = Task { [weak self] in
        await self?.readLoop(key: key, task: task)
      }
    } catch {
      socketIsOpen = false
      eventSink.yield(.error(error.localizedDescription))
    }
  }

  /// Drops the socket but KEEPS the emulator — this runs at the top of every
  /// `connect`, so clearing it here would defeat scrollback reuse on a
  /// foreground reconnect.
  func disconnect() {
    // Order matters: `sendFocus` needs the socket, so the frame has to go out
    // before it is torn down. Otherwise the server keeps believing the old
    // session is on screen, and keeps suppressing its pushes.
    sendFocus(focused: false)
    lastFocusSent = nil
    readTask?.cancel()
    readTask = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    socketIsOpen = false
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

  /// What to do with this socket after the app came back to the foreground.
  func resumeAction(nowMs: Int64) -> ResumeAction {
    ResumeLogic.action(open: socketIsOpen, lastSeenMs: lastTrafficMs, nowMs: nowMs)
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

  private func handleOutbound(_ frame: OutboundFrame) {
    switch frame {
    case let .input(text, key):
      guard stillCurrent(key) else { return }
      send(["type": "input", "text": text])
    case let .paste(text, key):
      guard stillCurrent(key) else { return }
      // The emulator knows whether the program has bracketed paste on (DECSET
      // 2004) and builds the payload: fenced in `ESC[200~`/`ESC[201~` when it
      // does, with the clipboard's own fence markers stripped either way.
      send(["type": "input", "text": emulator?.pastePayload(text: text) ?? text])
    case let .focus(focused):
      sendFocus(focused: focused)
    case let .resize(newCols, newRows):
      resize(cols: newCols, rows: newRows)
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

  /// Adopts the grid the surface can actually display: resizes the local
  /// emulator AND tells the PTY, so the two agree and the shell wraps at the
  /// width the user can see.
  private func resize(cols newCols: UInt16, rows newRows: UInt16) {
    guard newCols != cols || newRows != rows else { return }
    cols = newCols
    rows = newRows
    emulator?.resize(cols: newCols, rows: newRows)
    publishSnapshot()
    send(["type": "resize", "cols": Int(newCols), "rows": Int(newRows)])
  }

  /// `{ type: "focus", focused }` — the server suppresses push while focused is
  /// true. `lastFocusSent` drops a repeat: scenePhase reports `.inactive` and
  /// then `.background` for one transition, and both mean the same thing here.
  func sendFocus(focused: Bool) {
    guard lastFocusSent != focused else { return }
    lastFocusSent = focused
    guard socketIsOpen, socket != nil else { return }
    send(["type": "focus", "focused": focused])
  }

  private func send(_ object: [String: Any]) {
    guard let socket else { return }
    guard
      let payload = try? JSONSerialization.data(withJSONObject: object),
      let frame = String(data: payload, encoding: .utf8)
    else { return }
    // The error used to be discarded here. Whatever else is losing keystrokes
    // (see the board task: ~5% of characters vanish under fast typing), a
    // swallowed send error guarantees the loss is silent — nothing on the
    // client or the server records that a keystroke never left the device.
    // Logged rather than surfaced: a transient send failure is not worth a
    // banner, but it must not be invisible to the next person measuring this.
    socket.send(.string(frame)) { error in
      #if DEBUG
      if let error {
        print("[Tether] frame send failed: \(error.localizedDescription)")
      }
      #endif
    }
  }

  // MARK: - Inbound

  private func readLoop(key: String, task: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await task.receive()
        switch message {
        case let .string(text):
          handleServerFrame(text, key: key)
        case let .data(data):
          if let text = String(data: data, encoding: .utf8) {
            handleServerFrame(text, key: key)
          }
        @unknown default:
          break
        }
      } catch {
        socketIsOpen = false
        if !Task.isCancelled {
          eventSink.yield(.error("Connection closed"))
        }
        break
      }
    }
    if socket === task {
      socketIsOpen = false
    }
  }

  private func handleServerFrame(_ text: String, key: String) {
    // Stale socket: the active terminal moved on since this connection opened.
    guard key == emulatorKey else { return }
    guard
      let data = text.data(using: .utf8),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = json["type"] as? String
    else { return }

    noteTraffic()

    switch type {
    case "output":
      // The id advances the replay cursor; the chunk is the actual terminal
      // output and must reach the parser, or the surface stays blank however
      // much data arrives. `acceptOutput` is the duplicate guard — it returns
      // false for a frame already applied, and feeding anyway makes a repeated
      // frame reach the parser twice ("abc" typed, "aabbcc" on screen).
      if let id = json["id"] as? UInt64,
        !replayStore.acceptOutput(sessionId: key, id: id)
      {
        return
      }
      if let chunk = json["chunk"] as? String, let bytes = chunk.data(using: .utf8) {
        emulator?.feed(bytes: bytes)
        publishSnapshot()
      }
    case "reset":
      replayStore.reset(sessionId: key)
      // A reset means the client's history has a hole; rebuild the grid rather
      // than letting the old contents linger under the replayed tail. This is
      // the one case where a same-session rebuild is right.
      emulator = FfiTerminalEmulator(cols: cols, rows: rows)
      emulatorKey = key
      lastRenderedGeneration = nil
      snapshotSink.yield(nil)
    case "ping":
      break
    case "title", "activity", "exit":
      eventSink.yield(.sessionsChanged)
    default:
      break
    }
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
