import Foundation
import SwiftTerm

/// PTY bytes in, `TerminalFrame` out. SwiftTerm parses; this owns what SwiftTerm
/// keeps private (cursor visibility, scrollback position) and maps cells into
/// the renderer's model.
///
/// Not thread-safe: only `TerminalPipeline`'s actor touches it.
final class TerminalEngine {
  private let terminal: Terminal
  private let delegate: EngineDelegate
  private var generationCounter: UInt64 = 0
  private var cached: TerminalFrame
  private var needsRefresh = false
  /// Lines above the live bottom the view is scrolled back; 0 = live.
  private var scrollOffset = 0
  /// `buffer.yDisp` at the live bottom. SwiftTerm keeps yDisp following output
  /// only while it sits at the bottom, so it is put back here before every
  /// feed and resize.
  private var liveTop = 0

  init(cols: UInt16, rows: UInt16, scrollback: Int = 10_000) {
    let delegate = EngineDelegate()
    self.delegate = delegate
    var options = TerminalOptions.default
    options.cols = Int(max(cols, 1))
    options.rows = Int(max(rows, 1))
    options.scrollback = scrollback
    // Default .base16Lab derives 16–255 from the theme; keep the xterm cube.
    options.ansi256PaletteStrategy = .xterm
    terminal = Terminal(delegate: delegate, options: options)
    TerminalPalette.install(on: terminal)
    cached = TerminalFrame(
      header: GridSnapshot.Header(
        cols: 0, rows: 0, cursorCol: 0, cursorRow: 0, generation: 0, cursorVisible: true),
      cells: [])
    cached = TerminalFrame(header: currentHeader(), cells: buildCells())
    terminal.clearUpdateRange()
  }

  var generation: UInt64 {
    refresh()
    return generationCounter
  }

  func frame() -> TerminalFrame {
    refresh()
    return cached
  }

  var altScreen: Bool { terminal.isCurrentBufferAlternate }
  var bracketedPaste: Bool { terminal.bracketedPasteMode }

  var mouseMode: MouseMode {
    switch terminal.mouseMode {
    case .off: return .off
    case .x10: return .x10
    case .vt200: return .normal
    case .buttonEventTracking: return .button
    case .anyEvent: return .any
    }
  }

  /// Bits 3–5 of `hostPointerModes` are the report encoding; 2 is SGR (1006).
  var mouseSgr: Bool { (terminal.hostPointerModes >> 3) & 0b111 == 2 }

  func pastePayload(_ text: String) -> String {
    PastePayload.make(text, bracketed: bracketedPaste)
  }

  /// Answers to DA/DSR/DECRQM queries produced since the last call.
  func takeReplies() -> [UInt8] {
    defer { delegate.replies.removeAll(keepingCapacity: true) }
    return delegate.replies
  }

  func discardReplies() {
    delegate.replies.removeAll()
  }

  func feed(_ bytes: Data) {
    guard !bytes.isEmpty else { return }
    let pinned = scrollOffset
    let oldLiveTop = liveTop
    let trimmedBefore = terminal.buffer.totalLinesTrimmed
    returnToLive()
    terminal.feed(byteArray: [UInt8](bytes))
    liveTop = terminal.buffer.yDisp
    guard pinned > 0, !terminal.isCurrentBufferAlternate else {
      scrollOffset = 0
      return
    }
    let trimmed = terminal.buffer.totalLinesTrimmed - trimmedBefore
    let top = max(0, oldLiveTop - pinned - trimmed)
    terminal.buffer.yDisp = top
    scrollOffset = liveTop - top
    needsRefresh = true
  }

  func resize(cols: UInt16, rows: UInt16) {
    guard cols > 0, rows > 0 else { return }
    let dims = terminal.getDims()
    guard Int(cols) != dims.cols || Int(rows) != dims.rows else { return }
    returnToLive()
    scrollOffset = 0
    terminal.resize(cols: Int(cols), rows: Int(rows))
    liveTop = terminal.buffer.yDisp
    needsRefresh = true
  }

  /// Positive `lines` moves into history, negative toward the live bottom.
  /// No-op on the alt screen, which has no scrollback.
  func scrollViewport(lines: Int32) {
    guard lines != 0, !terminal.isCurrentBufferAlternate else { return }
    let next = min(max(scrollOffset + Int(lines), 0), liveTop)
    guard next != scrollOffset else { return }
    scrollOffset = next
    terminal.buffer.yDisp = liveTop - scrollOffset
    needsRefresh = true
  }

  private func returnToLive() {
    guard scrollOffset > 0, !terminal.isCurrentBufferAlternate else { return }
    terminal.buffer.yDisp = liveTop
  }

  private func refresh() {
    let header = currentHeader()
    let stateChanged = !Self.sameState(header, cached.header)
    guard needsRefresh || stateChanged || terminal.getUpdateRange() != nil else { return }
    needsRefresh = false
    terminal.clearUpdateRange()
    let cells = buildCells()
    if stateChanged || cells != cached.cells {
      generationCounter &+= 1
    }
    var stamped = header
    stamped.generation = generationCounter
    cached = TerminalFrame(header: stamped, cells: cells)
  }

  private static func sameState(_ lhs: GridSnapshot.Header, _ rhs: GridSnapshot.Header) -> Bool {
    var lhs = lhs
    lhs.generation = rhs.generation
    return lhs == rhs
  }

  private func currentHeader() -> GridSnapshot.Header {
    let dims = terminal.getDims()
    let cursor = terminal.getCursorLocation()
    return GridSnapshot.Header(
      cols: UInt16(clamping: dims.cols),
      rows: UInt16(clamping: dims.rows),
      cursorCol: UInt16(clamping: min(max(cursor.x, 0), dims.cols - 1)),
      cursorRow: UInt16(clamping: min(max(cursor.y + scrollOffset, 0), dims.rows - 1)),
      generation: generationCounter,
      cursorVisible: delegate.cursorVisible,
      altScreen: terminal.isCurrentBufferAlternate)
  }

  private func buildCells() -> [GridSnapshot.Cell] {
    let dims = terminal.getDims()
    var cells = [GridSnapshot.Cell](repeating: TerminalPalette.blankCell, count: dims.cols * dims.rows)
    let palette = TerminalPalette.table(of: terminal)
    for row in 0..<dims.rows {
      guard let line = terminal.getLine(row: row) else { continue }
      for col in 0..<min(dims.cols, line.count) {
        cells[row * dims.cols + col] = Self.cell(line[col], palette: palette)
      }
    }
    return cells
  }

  private static func cell(_ data: CharData, palette: [UInt32]) -> GridSnapshot.Cell {
    let attribute = data.attribute
    return GridSnapshot.Cell(
      codepoint: codepoint(data),
      foreground: TerminalPalette.resolve(attribute.fg, isForeground: true, palette: palette),
      background: TerminalPalette.resolve(attribute.bg, isForeground: false, palette: palette),
      attrs: attrs(attribute.style))
  }

  /// One codepoint per cell: combining marks NFC-compose into their base;
  /// a grapheme that does not compose keeps its first scalar.
  private static func codepoint(_ data: CharData) -> UInt32 {
    // Width 0 is the tail of a wide glyph.
    guard data.width != 0 else { return 0x20 }
    // getText, not getCharacter: the latter runs grapheme segmentation per cell.
    let text = data.getText()
    var scalars = text.unicodeScalars.makeIterator()
    guard let first = scalars.next() else { return 0x20 }
    // Nearly every cell is one scalar; normalization is the expensive path.
    if scalars.next() == nil {
      return first.value == 0 ? 0x20 : first.value
    }
    return text.precomposedStringWithCanonicalMapping.unicodeScalars.first?.value ?? 0x20
  }

  private static func attrs(_ style: CharacterStyle) -> UInt32 {
    var bits: UInt32 = 0
    if style.contains(.bold) { bits |= GridSnapshot.attrBold }
    if style.contains(.italic) { bits |= GridSnapshot.attrItalic }
    if style.contains(.underline) { bits |= GridSnapshot.attrUnderline }
    if style.contains(.inverse) { bits |= GridSnapshot.attrInverse }
    if style.contains(.dim) { bits |= GridSnapshot.attrDim }
    if style.contains(.crossedOut) { bits |= GridSnapshot.attrStrikethrough }
    return bits
  }
}

private final class EngineDelegate: TerminalDelegate {
  var cursorVisible = true
  var replies: [UInt8] = []

  func send(source: Terminal, data: ArraySlice<UInt8>) {
    replies.append(contentsOf: data)
  }

  func showCursor(source: Terminal) { cursorVisible = true }
  func hideCursor(source: Terminal) { cursorVisible = false }
}
