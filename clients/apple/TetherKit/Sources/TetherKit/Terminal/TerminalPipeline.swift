import Foundation
import TetherFFIBindings

/// Everything the pipeline tells the store that is not a grid.
///
/// Kept separate from the snapshot stream on purpose: snapshots are allowed to
/// be dropped when the main actor falls behind (only the newest one matters),
/// and these are not.
public enum TerminalPipelineEvent: Sendable {
  case mouseModes(mode: MouseMode, sgr: Bool)
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
  /// `key` is the session the text was typed INTO, so a frame queued just
  /// before a session switch is not delivered to the session that replaced it.
  case input(String, key: String?)
  case paste(String, key: String?)
  /// Resize the LOCAL emulator only (fires on every reported size change).
  case localResize(cols: UInt16, rows: UInt16)
  /// Resize the server PTY only (fires once the bounds settle).
  case serverResize(cols: UInt16, rows: UInt16)
}

/// Owns the terminal byte stream and the VT emulator, off the main actor.
///
/// The read path runs on the actor's own executor; the main actor only receives
/// the newest grid, so a chatty program never saturates the run loop.
actor TerminalPipeline {
  /// Newest-wins: if the main actor is busy, intermediate grids are dropped
  /// rather than queued. `nil` means "clear the surface".
  nonisolated let snapshots: AsyncStream<Data?>
  nonisolated let events: AsyncStream<TerminalPipelineEvent>
  /// Callable from any isolation without awaiting — see `OutboundFrame`.
  nonisolated let outbound: AsyncStream<OutboundFrame>.Continuation

  private let snapshotSink: AsyncStream<Data?>.Continuation
  private let eventSink: AsyncStream<TerminalPipelineEvent>.Continuation
  private let outboundFrames: AsyncStream<OutboundFrame>

  private let replayStore: FfiReplayStore
  private let snapshotCache = TerminalSnapshotCache()
  private let sessionGrids = TerminalSessionGrids()
  private var currentGrid: TerminalSessionGrid?
  private var emulator: FfiTerminalEmulator? { currentGrid?.emulator }
  private var outputBuffer: TerminalOutputBuffer { currentGrid?.buffer ?? TerminalOutputBuffer() }
  /// Which session key `emulator` holds the scrollback for.
  private var emulatorKey: String?
  private var sshTransport: (any TerminalByteStream)?
  private var sshReadTask: Task<Void, Never>?
  private var outboundTask: Task<Void, Never>?
  private var lastRenderedGeneration: UInt64?
  private var lastMouseMode: MouseMode = .off
  private var lastMouseSgr = true
  private var lastAltScreen = false
  /// When false, output is still fed to the emulator and the replay cursor still
  /// advances, but grid snapshots are not produced — a background (non-visible)
  /// session stays current without paying to rasterize.
  private var rendering = true
  /// One source of truth for the grid size: the channel, the parser and any
  /// later resize must agree or the rendered grid will not match the PTY.
  private var cols: UInt16 = 80
  private var rows: UInt16 = 24

  /// The replay cursor store is injected (and shared across every pipeline) so
  /// N concurrent sessions never write the persisted cursor file at once.
  init(replayStore: FfiReplayStore) {
    self.replayStore = replayStore
    (snapshots, snapshotSink) = AsyncStream.makeStream(
      of: Optional<Data>.self,
      bufferingPolicy: .bufferingNewest(1)
    )
    (events, eventSink) = AsyncStream.makeStream(of: TerminalPipelineEvent.self)
    (outboundFrames, outbound) = AsyncStream.makeStream(of: OutboundFrame.self)
  }

  // MARK: - Connection

  /// Pumps an authenticated SSH PTY into the emulator and snapshot stream.
  /// Connection/authentication belongs to the caller; this boundary is just raw
  /// terminal bytes, so it is also testable without a host.
  func connectSSH(transport: any TerminalByteStream, key: String) async {
    disconnect()
    startOutboundPumpIfNeeded()
    let attached = sessionGrids.attach(key: key, cols: cols, rows: rows)
    currentGrid = attached.grid
    emulatorKey = key
    lastRenderedGeneration = nil
    lastAltScreen = attached.grid.lastAltScreen
    if attached.reused {
      publishSnapshot()
    } else {
      snapshotSink.yield(nil)
    }
    resetMouseModes()
    sshTransport = transport
    sshReadTask = Task { [weak self] in
      await self?.readLoopSSH(key: key, transport: transport)
    }
  }

  private func readLoopSSH(key: String, transport: any TerminalByteStream) async {
    do {
      while !Task.isCancelled, let bytes = try await transport.read() {
        guard key == emulatorKey else { continue }
        applyOutput(bytes)
      }
      if !Task.isCancelled, key == emulatorKey {
        sshTransport = nil
        eventSink.yield(.error("Connection closed"))
      }
    } catch {
      if !Task.isCancelled, key == emulatorKey {
        sshTransport = nil
        eventSink.yield(.error(error.localizedDescription))
      }
    }
  }

  /// Drops the transport but KEEPS the emulator, so a foreground reconnect to
  /// the same session reuses its scrollback.
  func disconnect() {
    sshReadTask?.cancel()
    sshReadTask = nil
    if let transport = sshTransport {
      sshTransport = nil
      Task { await transport.close() }
    }
  }

  /// Leaves the terminal entirely, as opposed to reconnecting to the same
  /// session: the emulator and its scrollback go too.
  func release() {
    disconnect()
    currentGrid = nil
    emulatorKey = nil
    lastRenderedGeneration = nil
    snapshotSink.yield(nil)
    resetMouseModes()
  }

  func forget(key: String) {
    replayStore.forget(sessionId: key)
    snapshotCache.forget(key)
    sessionGrids.forget(key)
    if emulatorKey == key {
      currentGrid = nil
      emulatorKey = nil
    }
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
    switch frame {
    case let .input(text, key):
      guard let transport = sshTransport, stillCurrent(key) else { return }
      do {
        try await transport.write(Data(text.utf8))
      } catch {
        sshTransport = nil
        eventSink.yield(.error(error.localizedDescription))
      }
    case let .paste(text, key):
      guard let transport = sshTransport, stillCurrent(key) else { return }
      let payload = emulator?.pastePayload(text: text) ?? text
      do {
        try await transport.write(Data(payload.utf8))
      } catch {
        sshTransport = nil
        eventSink.yield(.error(error.localizedDescription))
      }
    case let .localResize(newCols, newRows):
      // Local emulator only — no PTY resize, so no SIGWINCH. Keeps the rendered
      // grid matching the view through a keyboard animation's every frame.
      applyLocalResize(cols: newCols, rows: newRows)
    case let .serverResize(newCols, newRows):
      // Settled size → the PTY. Apply locally too in case the socket was nil
      // while the emulator resized (reconnect).
      applyLocalResize(cols: newCols, rows: newRows)
      if let transport = sshTransport {
        await transport.resize(cols: newCols, rows: newRows)
      }
    }
  }

  /// Whether a queued frame still belongs to the terminal on screen.
  private func stillCurrent(_ key: String?) -> Bool {
    guard let key else { return true }
    return key == emulatorKey
  }

  /// Resizes the LOCAL emulator and records the new grid size. Returns whether
  /// the size actually changed, so the caller only puts a resize frame on the
  /// wire when it did.
  @discardableResult
  private func applyLocalResize(cols newCols: UInt16, rows newRows: UInt16) -> Bool {
    let oldCols = cols
    let oldRows = rows
    guard newCols != cols || newRows != rows else { return false }
    cols = newCols
    rows = newRows
    if TerminalResizeStrategy.shouldRebuildFromBuffer(
      altScreen: lastAltScreen,
      oldCols: oldCols, oldRows: oldRows, newCols: newCols, newRows: newRows
    ), !outputBuffer.data.isEmpty {
      currentGrid?.emulator = outputBuffer.replay(cols: newCols, rows: newRows)
      lastRenderedGeneration = nil
      publishSnapshot()
      return true
    }
    emulator?.resize(cols: newCols, rows: newRows)
    // An empty buffer means we are still waiting on output and a cached grid is
    // on screen — publishing the empty emulator would flash blank.
    if outputBuffer.data.isEmpty { return true }
    if TerminalResizePublish.shouldPublishAfterResize(
      oldCols: oldCols, oldRows: oldRows, newCols: newCols, newRows: newRows
    ) {
      publishSnapshot()
    }
    return true
  }

  /// Full transcript of the retained output buffer as plain text. Replays the
  /// raw byte stream into a throwaway emulator tall enough that the whole
  /// history lands on one grid (snapshot only sees the visible rows), then
  /// decodes it. The buffer is byte-capped, so a very long session shows the
  /// recent tail.
  func historyText() -> String {
    guard let buffer = currentGrid?.buffer, !buffer.data.isEmpty else { return "" }
    let newlines = buffer.data.reduce(into: 0) { if $1 == 0x0A { $0 += 1 } }
    let tall = UInt16(min(20_000, max(Int(rows), newlines + Int(rows) + 2)))
    let emulator = buffer.replay(cols: cols, rows: tall)
    guard let decoded = try? GridSnapshotDecoder.decode(emulator.snapshot()) else { return "" }
    return TerminalGridText.plainText(header: decoded.0, cells: decoded.1)
  }

  private func applyOutput(_ bytes: Data) {
    outputBuffer.append(bytes)
    emulator?.feed(bytes: bytes)
    publishSnapshot()
  }

  /// Toggle grid rasterization. A background (non-visible) session sets this
  /// false: output keeps feeding the emulator, but no snapshot is produced until
  /// it becomes visible again.
  func setRendering(_ on: Bool) {
    rendering = on
    if on {
      // Force a fresh frame even when the grid is unchanged since it last
      // rendered, so a session switched back into view is not stuck on the
      // previous tab's frame until the next byte of output arrives.
      lastRenderedGeneration = nil
      publishSnapshot()
    }
  }

  var isConnected: Bool { sshTransport != nil }

  #if DEBUG
  /// Test seam: stand up a live emulator without a connection.
  func attachForTest(cols: UInt16, rows: UInt16) {
    let attached = sessionGrids.attach(key: "test", cols: cols, rows: rows)
    currentGrid = attached.grid
    emulatorKey = "test"
    self.cols = cols
    self.rows = rows
  }

  /// Test seam: feed bytes through the normal output path.
  func feedForTest(_ bytes: Data) { applyOutput(bytes) }
  #endif

  // MARK: - Publishing

  /// Publishes a new grid only when the visible contents actually changed.
  ///
  /// `generation` is why this is cheap: it is compared before pulling the
  /// packed bytes, so a burst of output that does not alter the viewport costs
  /// nothing beyond the counter read.
  private func publishSnapshot() {
    guard rendering else { return }
    guard let emulator else { return }
    let generation = emulator.generation()
    // Mouse mode can flip without a viewport change (e.g. vim entering or
    // leaving mouse tracking). Keep the surface's input path in sync either way.
    syncMouseModes(from: emulator)
    guard generation != lastRenderedGeneration else { return }
    lastRenderedGeneration = generation
    let packed = emulator.snapshot()
    if let header = try? GridSnapshotDecoder.peekHeader(packed) {
      lastAltScreen = header.altScreen
      currentGrid?.lastAltScreen = header.altScreen
    }
    if let emulatorKey {
      snapshotCache.remember(packed, for: emulatorKey)
    }
    snapshotSink.yield(packed)
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
}
