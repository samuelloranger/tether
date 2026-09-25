import Foundation

/// Non-grid pipeline output. Unlike snapshots (newest-wins), these are never dropped.
public enum TerminalPipelineEvent: Sendable {
  case mouseModes(mode: MouseMode, sgr: Bool)
  /// A full-screen program took or left the screen: a typed command may not reach a shell.
  case altScreen(Bool)
  /// Live output rang the terminal bell. Never sent for replayed output.
  case bell
  case error(String)
}

/// Streamed rather than awaited: a `Task { await … }` per keystroke has no defined order,
/// while `Continuation.yield` is FIFO and needs no await.
enum OutboundFrame: Sendable {
  /// `key` is the session the text was typed INTO, so a frame queued just
  /// before a session switch is not delivered to the session that replaced it.
  case input(String, key: String?)
  case paste(String, key: String?)
  /// The emulator's answer to a terminal query (DA, DSR…). Queued, not written
  /// directly, so it stays ordered with typed input.
  case reply(Data, key: String?)
  /// Resize the LOCAL emulator only (fires on every reported size change).
  case localResize(cols: UInt16, rows: UInt16)
  /// Resize the server PTY only (fires once the bounds settle).
  case serverResize(cols: UInt16, rows: UInt16)
}

/// The main actor only receives the newest grid, so a chatty program never saturates it.
actor TerminalPipeline {
  /// Newest-wins: if the main actor is busy, intermediate grids are dropped
  /// rather than queued. `nil` means "clear the surface".
  nonisolated let snapshots: AsyncStream<TerminalFrame?>
  nonisolated let events: AsyncStream<TerminalPipelineEvent>
  /// Callable from any isolation without awaiting — see `OutboundFrame`.
  nonisolated let outbound: AsyncStream<OutboundFrame>.Continuation

  private let snapshotSink: AsyncStream<TerminalFrame?>.Continuation
  private let eventSink: AsyncStream<TerminalPipelineEvent>.Continuation
  private let outboundFrames: AsyncStream<OutboundFrame>

  private let sessionGrids = TerminalSessionGrids()
  private var cellPixelSize: (width: Int, height: Int)?
  private var currentGrid: TerminalSessionGrid?
  private var emulator: TerminalEngine? { currentGrid?.emulator }
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
  /// One source of truth for the grid size: the channel, the parser and any
  /// later resize must agree or the rendered grid will not match the PTY.
  private var cols: UInt16 = 80
  private var rows: UInt16 = 24

  /// `theme` is the one the first grid is created in, so the first frame is never drawn in
  /// the default colors.
  init(theme: TerminalTheme = .tether) {
    sessionGrids.theme = theme
    (snapshots, snapshotSink) = AsyncStream.makeStream(
      of: Optional<TerminalFrame>.self,
      bufferingPolicy: .bufferingNewest(1)
    )
    (events, eventSink) = AsyncStream.makeStream(of: TerminalPipelineEvent.self)
    (outboundFrames, outbound) = AsyncStream.makeStream(of: OutboundFrame.self)
  }

  // MARK: - Connection

  /// Connection and auth belong to the caller: this takes raw PTY bytes, so it tests hostless.
  func connectSSH(transport: any TerminalByteStream, key: String) async {
    disconnect()
    imagesWatchable = true
    startOutboundPumpIfNeeded()
    let attached = sessionGrids.attach(key: key, cols: cols, rows: rows)
    currentGrid = attached.grid
    if let cellPixelSize { attached.grid.emulator.setCellPixelSize(width: cellPixelSize.width, height: cellPixelSize.height) }
    emulatorKey = key
    lastRenderedGeneration = nil
    lastAltScreen = attached.grid.lastAltScreen
    eventSink.yield(.altScreen(lastAltScreen))
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
        // A replaced connection's closed stream still yields buffered chunks under the same
        // key; only cancellation tells them apart from the live connection's output.
        guard !Task.isCancelled else { break }
        guard key == emulatorKey else { continue }
        applyOutput(bytes)
      }
      if !Task.isCancelled, key == emulatorKey {
        connectionLost()
        eventSink.yield(.error("Connection closed"))
      }
    } catch {
      if !Task.isCancelled, key == emulatorKey {
        connectionLost()
        eventSink.yield(.error(error.localizedDescription))
      }
    }
  }

  /// The stream ended by itself: nothing new will arrive, so the image watch stops too.
  private func connectionLost() {
    sshTransport = nil
    imagesWatchable = false
    watchImages(nil)
  }

  /// Drops the transport but KEEPS the emulator, so a foreground reconnect to
  /// the same session reuses its scrollback.
  func disconnect() {
    imagesWatchable = false
    watchImages(nil)
    sshReadTask?.cancel()
    sshReadTask = nil
    if let transport = sshTransport {
      sshTransport = nil
      Task { await transport.close() }
    }
  }

  // MARK: - Local emulator control

  /// SwiftTerm advances kitty animations on its own timer and tells no one; while images
  /// are on screen the frame is re-read, at 20 Hz while it keeps changing and backing off
  /// to once a second while it doesn't, so a still image costs next to nothing.
  private var imageWatch: Task<Void, Never>?
  private weak var watchedEmulator: TerminalEngine?
  private static let fastWatch = Duration.milliseconds(50)
  private static let slowWatch = Duration.seconds(1)
  private var watchDelay = fastWatch

  private func watchTick() {
    let changed = publishSnapshot()
    watchDelay = changed ? Self.fastWatch : min(watchDelay * 2, Self.slowWatch)
  }

  /// Off while disconnected: nothing new can arrive, and a later local redraw (a scroll)
  /// must not start polling again.
  private var imagesWatchable = false
  private var imageWatchStarts = 0

  private func watchImages(_ emulator: TerminalEngine?) {
    let wanted = imagesWatchable ? emulator : nil
    guard wanted !== watchedEmulator || (wanted != nil && imageWatch == nil) else { return }
    imageWatch?.cancel()
    imageWatch = nil
    watchedEmulator = wanted
    guard wanted != nil else { return }
    watchDelay = Self.fastWatch
    imageWatchStarts += 1
    imageWatch = Task { [weak self] in
      while let self {
        // A cancelled sleep ends the watch; it must not tick once more on its way out.
        do { try await Task.sleep(for: await self.watchDelay) } catch { return }
        await self.watchTick()
      }
    }
  }

  private var themeSequence: UInt64 = 0

  /// Calls from separate tasks can arrive out of order; the newest request wins.
  func setTheme(_ theme: TerminalTheme, sequence: UInt64) {
    guard sequence > themeSequence else { return }
    themeSequence = sequence
    guard theme != sessionGrids.theme else { return }
    sessionGrids.theme = theme
    publishSnapshot()
  }

  /// New output while the watch was backed off: a sleep already under way would hold the
  /// next animation frame back by up to a second, so start over at the fast interval.
  private func speedUpImageWatch() {
    guard watchDelay != Self.fastWatch, let emulator = watchedEmulator else {
      watchDelay = Self.fastWatch
      return
    }
    imageWatch?.cancel()
    imageWatch = nil
    watchImages(emulator)
  }

  /// Scrolls the local VT viewport through scrollback (not PTY PgUp/PgDn).
  /// Positive `lines` moves into history; negative toward the live bottom.
  func scrollViewport(lines: Int32) {
    guard lines != 0, let emulator else { return }
    emulator.scrollViewport(lines: lines)
    publishSnapshot()
  }

  func setCellPixelSize(width: Int, height: Int) {
    cellPixelSize = (width, height)
    emulator?.setCellPixelSize(width: width, height: height)
  }

  /// False when the shell marked no OSC 133 prompt in that direction.
  func jumpToPrompt(_ direction: PromptJump) -> Bool {
    guard let emulator, emulator.jumpToPrompt(direction) else { return false }
    publishSnapshot()
    return true
  }

  func lastCommandOutput() -> String? {
    emulator?.lastCommandOutput()
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
      await write(Data(text.utf8), key: key)
    case let .paste(text, key):
      await write(Data((emulator?.pastePayload(text) ?? text).utf8), key: key)
    case let .reply(bytes, key):
      await write(bytes, key: key)
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

  private func write(_ bytes: Data, key: String?) async {
    guard let transport = sshTransport, stillCurrent(key) else { return }
    do {
      try await transport.write(bytes)
    } catch {
      sshTransport = nil
      eventSink.yield(.error(error.localizedDescription))
    }
  }

  /// Whether a queued frame still belongs to the terminal on screen.
  private func stillCurrent(_ key: String?) -> Bool {
    guard let key else { return true }
    return key == emulatorKey
  }

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
      let carried = currentGrid?.emulator.paletteOverrideEntries() ?? []
      let carriedCursor = currentGrid?.emulator.programCursor
      let rebuilt = outputBuffer.replay(
        cols: newCols, rows: newRows, theme: sessionGrids.theme, cellPixelSize: cellPixelSize
      )
      rebuilt.restorePaletteOverrides(carried)
      rebuilt.restoreProgramCursor(carriedCursor)
      currentGrid?.emulator = rebuilt
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

  /// Replays into an emulator tall enough to hold the whole history, since a frame only covers
  /// the visible rows. The buffer is byte-capped, so a long session yields only its tail.
  func historyText() -> String {
    guard let buffer = currentGrid?.buffer, !buffer.data.isEmpty else { return "" }
    let newlines = buffer.data.reduce(into: 0) { if $1 == 0x0A { $0 += 1 } }
    let tall = UInt16(min(20_000, max(Int(rows), newlines + Int(rows) + 2)))
    let frame = buffer.replay(cols: cols, rows: tall).frame()
    return TerminalGridText.plainText(header: frame.header, cells: frame.cells)
  }

  private func applyOutput(_ bytes: Data) {
    outputBuffer.append(bytes)
    if let emulator {
      emulator.feed(bytes)
      let replies = emulator.takeReplies()
      if !replies.isEmpty {
        outbound.yield(.reply(Data(replies), key: emulatorKey))
      }
      if emulator.takeBells() > 0 { eventSink.yield(.bell) }
    }
    publishSnapshot()
  }

  #if DEBUG
  /// Test seam: stand up a live emulator without a connection.
  func attachForTest(cols: UInt16, rows: UInt16) {
    imagesWatchable = true
    let attached = sessionGrids.attach(key: "test", cols: cols, rows: rows)
    currentGrid = attached.grid
    emulatorKey = "test"
    self.cols = cols
    self.rows = rows
  }

  /// Test seam: feed bytes through the normal output path.
  func feedForTest(_ bytes: Data) { applyOutput(bytes) }

  var isWatchingImagesForTest: Bool { imageWatch != nil }
  var imageWatchDelayForTest: Duration { watchDelay }
  var imageWatchStartsForTest: Int { imageWatchStarts }
  func imageWatchTickForTest() { watchTick() }
  /// Test seam: the current emulator's frame.
  func frameForTest() -> TerminalFrame? { emulator?.frame() }
  #endif

  // MARK: - Publishing

  /// Publishes a new grid only when the visible contents actually changed: the
  /// engine returns its cached frame (copy-on-write) until something dirties it.
  /// True when a new frame went out.
  @discardableResult
  private func publishSnapshot() -> Bool {
    guard let emulator else { return false }
    let frame = emulator.frame()
    watchImages(frame.images.isEmpty ? nil : emulator)
    // Mouse mode can flip without a viewport change (e.g. vim entering or
    // leaving mouse tracking). Keep the surface's input path in sync either way.
    syncMouseModes(from: emulator)
    guard frame.header.generation != lastRenderedGeneration else { return false }
    lastRenderedGeneration = frame.header.generation
    // Output or an animation frame: watch closely again.
    speedUpImageWatch()
    if frame.header.altScreen != lastAltScreen {
      lastAltScreen = frame.header.altScreen
      currentGrid?.lastAltScreen = frame.header.altScreen
      eventSink.yield(.altScreen(frame.header.altScreen))
    }
    snapshotSink.yield(frame)
    return true
  }

  private func syncMouseModes(from emulator: TerminalEngine) {
    let mode = emulator.mouseMode
    let sgr = emulator.mouseSgr
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
