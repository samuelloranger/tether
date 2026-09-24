import Foundation
import SwiftTerm

/// Every entry point takes SwiftTerm's `terminalLock`: its synchronized-output
/// watchdog mutates the terminal from its own queue.
final class TerminalEngine {
  private let terminal: Terminal
  private let delegate: EngineDelegate
  private var generationCounter: UInt64 = 0
  private var cached = TerminalFrame(
    header: GridSnapshot.Header(cols: 0, rows: 0, cursorCol: 0, cursorRow: 0, generation: 0, cursorVisible: true),
    cells: [])
  /// Rebuilt only when a program repaints the palette (OSC 4/104).
  private var palette: [UInt32] = []
  private var needsRefresh = false
  /// Lines above the live bottom the view is scrolled back; 0 = live.
  private var scrollOffset = 0
  /// `buffer.yDisp` at the live bottom. SwiftTerm's yDisp follows output only while there,
  /// so it is restored before every feed and resize.
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
    palette = TerminalPalette.table(of: terminal)
    let grid = buildGrid()
    cached = TerminalFrame(header: currentHeader(), cells: grid.cells, hyperlinks: grid.hyperlinks)
    terminal.clearUpdateRange()
  }

  func frame() -> TerminalFrame {
    locked {
      refresh()
      return cached
    }
  }

  var bracketedPaste: Bool { locked { terminal.bracketedPasteMode } }

  var mouseMode: MouseMode {
    locked {
      switch terminal.mouseMode {
      case .off: return .off
      case .x10: return .x10
      case .vt200: return .normal
      case .buttonEventTracking: return .button
      case .anyEvent: return .any
      }
    }
  }

  /// Bits 3–5 of `hostPointerModes` are the report encoding; 2 is SGR (1006).
  var mouseSgr: Bool { locked { (terminal.hostPointerModes >> 3) & 0b111 == 2 } }

  func pastePayload(_ text: String) -> String {
    PastePayload.make(text, bracketed: bracketedPaste)
  }

  /// Answers to DA/DSR/DECRQM queries produced since the last call.
  func takeReplies() -> [UInt8] {
    locked {
      defer { delegate.replies.removeAll(keepingCapacity: true) }
      return delegate.replies
    }
  }

  func discardReplies() {
    locked { delegate.replies.removeAll() }
  }

  func feed(_ bytes: Data) {
    guard !bytes.isEmpty else { return }
    locked { feedLocked(bytes) }
  }

  func resize(cols: UInt16, rows: UInt16) {
    guard cols > 0, rows > 0 else { return }
    locked { resizeLocked(cols: cols, rows: rows) }
  }

  /// Positive `lines` moves into history, negative toward the live bottom.
  /// No-op on the alt screen, which has no scrollback.
  func scrollViewport(lines: Int32) {
    guard lines != 0 else { return }
    locked { scrollLocked(lines: lines) }
  }

  /// Scrolls so the previous / next OSC 133 prompt is the top row. False when the shell
  /// has marked no prompt in that direction.
  @discardableResult
  func jumpToPrompt(_ direction: PromptJump) -> Bool {
    locked { jumpToPromptLocked(direction) }
  }

  /// Text of the newest finished command's output, from the OSC 133 marks. Nil when the
  /// shell marks no prompts or the last command printed nothing.
  func lastCommandOutput() -> String? {
    locked { lastCommandOutputLocked() }
  }

  /// The lock is a ticket lock and not re-entrant: take it once per entry point.
  private func locked<T>(_ body: () -> T) -> T {
    terminal.terminalLock.withLock(body)
  }

  private func feedLocked(_ bytes: Data) {
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
    let wanted = oldLiveTop - pinned - trimmed
    // ED 3 or RIS shrank the history under the view: what was being read is gone.
    guard trimmed >= 0, wanted <= liveTop else {
      scrollOffset = 0
      needsRefresh = true
      return
    }
    let top = max(0, wanted)
    terminal.buffer.yDisp = top
    scrollOffset = liveTop - top
    needsRefresh = true
  }

  private func resizeLocked(cols: UInt16, rows: UInt16) {
    let dims = terminal.getDims()
    guard Int(cols) != dims.cols || Int(rows) != dims.rows else { return }
    returnToLive()
    scrollOffset = 0
    terminal.resize(cols: Int(cols), rows: Int(rows))
    liveTop = terminal.buffer.yDisp
    needsRefresh = true
  }

  private func scrollLocked(lines: Int32) {
    guard !terminal.isCurrentBufferAlternate else { return }
    let next = min(max(scrollOffset + Int(lines), 0), liveTop)
    guard next != scrollOffset else { return }
    scrollOffset = next
    terminal.buffer.yDisp = liveTop - scrollOffset
    needsRefresh = true
  }

  /// Buffer-absolute rows (scrollback included) where a prompt group starts, oldest first.
  private func promptRows() -> [Int] {
    let last = liveTop + terminal.getDims().rows
    return (0..<last).filter { terminal.semanticRowKind(at: $0) == .initial }
  }

  private func jumpToPromptLocked(_ direction: PromptJump) -> Bool {
    guard !terminal.isCurrentBufferAlternate else { return false }
    let top = liveTop - scrollOffset
    let prompts = promptRows()
    let target: Int?
    switch direction {
    case .previous: target = prompts.last { $0 < top }
    case .next: target = prompts.first { $0 > top }
    }
    guard let target else { return false }
    // A prompt on the live screen is reached by going live, not by scrolling past it.
    let next = target >= liveTop ? 0 : liveTop - target
    guard next != scrollOffset else { return false }
    scrollOffset = next
    terminal.buffer.yDisp = liveTop - scrollOffset
    needsRefresh = true
    return true
  }

  private func lastCommandOutputLocked() -> String? {
    guard !terminal.isCurrentBufferAlternate else { return nil }
    let prompts = promptRows()
    // The newest prompt is the one waiting for input; the output before it belongs to the
    // command started from the prompt above.
    guard prompts.count >= 2 else { return nil }
    let cols = terminal.getDims().cols
    var lines: [String] = []
    for row in prompts[prompts.count - 2]..<prompts[prompts.count - 1] {
      guard let line = terminal.bufferLine(atRow: row) else { continue }
      var text = ""
      var any = false
      for col in 0..<min(cols, line.count) {
        guard terminal.semanticContent(at: Position(col: col, row: row)) == .output else { continue }
        any = true
        let data = line[col]
        if data.width == 0 { continue }
        let character = data.getText()
        text += character.isEmpty || character == "\u{0}" ? " " : character
      }
      if any { lines.append(text.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)) }
    }
    while lines.last?.isEmpty == true { lines.removeLast() }
    let output = lines.joined(separator: "\n")
    return output.isEmpty ? nil : output
  }

  private func returnToLive() {
    guard scrollOffset > 0, !terminal.isCurrentBufferAlternate else { return }
    terminal.buffer.yDisp = liveTop
  }

  private func refresh() {
    // A synchronized update (DECSET 2026) shows only once complete; the dirty
    // range survives, so the frame after it rebuilds.
    guard !terminal.synchronizedOutputActive else { return }
    let header = currentHeader()
    let stateChanged = !Self.sameState(header, cached.header)
    // OSC 4/104 repaint colors without touching the update range.
    guard needsRefresh || stateChanged || delegate.paletteChanged || terminal.getUpdateRange() != nil
    else { return }
    needsRefresh = false
    if delegate.paletteChanged {
      palette = TerminalPalette.table(of: terminal)
      delegate.paletteChanged = false
    }
    terminal.clearUpdateRange()
    let grid = buildGrid()
    if stateChanged || grid.cells != cached.cells || grid.hyperlinks != cached.hyperlinks {
      generationCounter &+= 1
    }
    var stamped = header
    stamped.generation = generationCounter
    cached = TerminalFrame(header: stamped, cells: grid.cells, hyperlinks: grid.hyperlinks)
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
      // Scrolled back past it, the cursor is below the view, not on a history line.
      cursorVisible: delegate.cursorVisible && cursor.y + scrollOffset < dims.rows,
      altScreen: terminal.isCurrentBufferAlternate)
  }

  private func buildGrid() -> (cells: [GridSnapshot.Cell], hyperlinks: [[LinkSpan]]) {
    let dims = terminal.getDims()
    var cells = [GridSnapshot.Cell](repeating: TerminalPalette.blankCell, count: dims.cols * dims.rows)
    var hyperlinks: [[LinkSpan]] = []
    for row in 0..<dims.rows {
      guard let line = terminal.getLine(row: row) else { continue }
      var open: (start: Int, target: LinkTarget)?
      func close(at end: Int) {
        guard let run = open else { return }
        if hyperlinks.isEmpty { hyperlinks = Array(repeating: [], count: dims.rows) }
        hyperlinks[row].append(LinkSpan(start: run.start, end: end, target: run.target))
        open = nil
      }
      for col in 0..<min(dims.cols, line.count) {
        let data = line[col]
        var cell = Self.cell(data, palette: palette)
        // A wide glyph's tail carries no payload of its own; it belongs to the head's link.
        let target = data.width == 0 ? open?.target : Self.hyperlinkTarget(data)
        if target != open?.target { close(at: col) }
        if let target {
          if open == nil { open = (col, target) }
          // Shown underlined: an OSC 8 link's text need not look like a URL.
          cell.attrs |= GridSnapshot.attrUnderline
        }
        cells[row * dims.cols + col] = cell
      }
      close(at: min(dims.cols, line.count))
    }
    return (cells, hyperlinks)
  }

  private static func hyperlinkTarget(_ data: CharData) -> LinkTarget? {
    guard data.hasPayload, let payload = data.getPayload() as? String else { return nil }
    return OSC8.target(payload: payload)
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

public enum PromptJump: Sendable {
  case previous, next
}

/// OSC 8 payloads as SwiftTerm stores them: `params;URI`.
enum OSC8 {
  /// Web links and `file://` paths only — the URI is whatever the remote program wrote.
  static func target(payload: String) -> LinkTarget? {
    guard let separator = payload.firstIndex(of: ";") else { return nil }
    let uri = String(payload[payload.index(after: separator)...])
    guard let url = URL(string: uri), let scheme = url.scheme?.lowercased() else { return nil }
    switch scheme {
    case "http", "https":
      return .external(url: uri)
    case "file":
      let path = url.path
      return path.isEmpty ? nil : .file(path: path, line: nil, column: nil)
    default:
      return nil
    }
  }
}

private final class EngineDelegate: TerminalDelegate {
  var cursorVisible = true
  var paletteChanged = false
  var replies: [UInt8] = []

  func send(source: Terminal, data: ArraySlice<UInt8>) {
    replies.append(contentsOf: data)
  }

  func showCursor(source: Terminal) { cursorVisible = true }
  func hideCursor(source: Terminal) { cursorVisible = false }
  func colorChanged(source: Terminal, idx: Int?) { paletteChanged = true }
}
