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
  /// Rebuilt only when a program repaints the palette (OSC 4/104) or the theme changes.
  private var palette: [UInt32] = []
  private var theme: TerminalTheme
  private var needsRefresh = false
  private var oscScanner = OSCScanner()
  /// OSC 133 A / C / D positions. `line` counts from the first line ever written, so it
  /// survives scrollback trimming; subtract `totalLinesTrimmed` for a buffer row.
  private var commandMarks: [CommandMark] = []
  /// Set by anything that can add, move or remove a kitty image, so an unchanged screen
  /// doesn't rebuild the graphics snapshot every refresh.
  private var graphicsDirty = true
  private let imageOwner = TerminalEngine.nextImageOwner()
  private static let ownerLock = NSLock()
  nonisolated(unsafe) private static var lastImageOwner: UInt64 = 0

  private static func nextImageOwner() -> UInt64 {
    ownerLock.lock(); defer { ownerLock.unlock() }
    lastImageOwner += 1
    return lastImageOwner
  }
  /// Lines above the live bottom the view is scrolled back; 0 = live.
  private var scrollOffset = 0
  /// `buffer.yDisp` at the live bottom. SwiftTerm's yDisp follows output only while there,
  /// so it is restored before every feed and resize.
  private var liveTop = 0

  init(cols: UInt16, rows: UInt16, scrollback: Int = 10_000, theme: TerminalTheme = .tether) {
    self.theme = theme
    let delegate = EngineDelegate()
    self.delegate = delegate
    var options = TerminalOptions.default
    options.cols = Int(max(cols, 1))
    options.rows = Int(max(rows, 1))
    options.scrollback = scrollback
    // Default .base16Lab derives 16–255 from the theme; keep the xterm cube.
    options.ansi256PaletteStrategy = .xterm
    // Sixel is parsed but never drawn; claiming it steers image tools away from kitty graphics.
    options.enableSixelReported = false
    terminal = Terminal(delegate: delegate, options: options)
    TerminalPalette.install(theme, on: terminal)
    palette = TerminalPalette.table(of: terminal, fallback: theme.foreground)
    let grid = buildGrid()
    cached = TerminalFrame(header: currentHeader(), cells: grid.cells, hyperlinks: grid.hyperlinks, images: .empty)
    terminal.clearUpdateRange()
  }

  func frame() -> TerminalFrame {
    locked {
      refresh()
      return cached
    }
  }

  /// Repaints every cell in the new colors. Entries a program set with OSC 4 are replaced.
  func setTheme(_ theme: TerminalTheme) {
    locked {
      guard theme != self.theme else { return }
      let old = self.theme
      let current = TerminalPalette.table(of: terminal, fallback: old.foreground)
      self.theme = theme
      TerminalPalette.install(theme, on: terminal)
      let fresh = TerminalPalette.table(of: terminal, fallback: theme.foreground)
      // Entries a program set with OSC 4 survive: the first 16 differ from the old theme's
      // own colors, the rest from the xterm cube every theme shares.
      let overrides = current.indices.filter { index in
        index < old.ansi.count ? current[index] != old.ansi[index] : current[index] != fresh[index]
      }
      if !overrides.isEmpty {
        // Fed to the local parser only; nothing reaches the host.
        terminal.feed(text: Self.paletteSequence(overrides.map { ($0, current[$0]) }))
      }
      palette = TerminalPalette.table(of: terminal, fallback: theme.foreground)
      graphicsDirty = true
      needsRefresh = true
    }
  }

  /// One OSC 4 setting each entry to its ARGB color.
  static func paletteSequence(_ entries: [(index: Int, argb: UInt32)]) -> String {
    let specs = entries.map { entry in
      "\(entry.index);rgb:" + String(
        format: "%02x/%02x/%02x", (entry.argb >> 16) & 0xFF, (entry.argb >> 8) & 0xFF, entry.argb & 0xFF
      )
    }
    return "\u{1B}]4;" + specs.joined(separator: ";") + "\u{1B}\\"
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

  /// The device-pixel size of one cell, which kitty graphics uses to size placements and
  /// answers pixel-size queries with.
  func setCellPixelSize(width: Int, height: Int) {
    guard width > 0, height > 0 else { return }
    locked {
      delegate.cellPixelSize = (width, height)
      graphicsDirty = true
    }
  }

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

  /// SwiftTerm keeps OSC 133 prompt marks but not where a command's output starts (C) and
  /// ends (D). Output is fed up to each of those, so the cursor there is exactly the mark.
  private func feedMarkingCommands(_ bytes: [UInt8]) {
    var start = 0
    var top = screenTopLine()
    // RIS, ED 3 and reflow renumber the buffer; marks from before would point at other rows.
    func feed(through end: Int) {
      terminal.feed(buffer: bytes[start..<end])
      start = end
      let now = screenTopLine()
      if now < top { commandMarks.removeAll() }
      top = now
    }
    for event in oscScanner.scan(bytes) {
      switch event {
      case let .reset(end):
        feed(through: end)
        commandMarks.removeAll()
      case let .osc("133", body, end):
        let kind: CommandMark.Kind
        switch body.first {
        case UInt8(ascii: "A"), UInt8(ascii: "N"), UInt8(ascii: "P"):
          // A secondary (PS2) or right prompt belongs to the command already being typed.
          let options = String(decoding: body, as: UTF8.self).split(separator: ";").dropFirst()
          guard !options.contains("k=s"), !options.contains("k=r") else { continue }
          kind = .prompt
        case UInt8(ascii: "C"): kind = .outputStart
        case UInt8(ascii: "D"): kind = .outputEnd
        default: continue
        }
        feed(through: end)
        guard !terminal.isCurrentBufferAlternate else { continue }
        let buffer = terminal.buffer
        commandMarks.append(CommandMark(
          kind: kind, line: buffer.yDisp + buffer.y + buffer.totalLinesTrimmed, col: buffer.x
        ))
        if commandMarks.count > 400 { commandMarks.removeFirst(commandMarks.count - 400) }
      default:
        continue
      }
    }
    if start < bytes.count { feed(through: bytes.count) }
  }

  /// The first screen row as a line count from the start of output. While output arrives
  /// the view is live, so yDisp is the top of the screen. It only goes backwards when the
  /// buffer was reset or its scrollback cleared.
  private func screenTopLine() -> Int {
    terminal.buffer.yDisp + terminal.buffer.totalLinesTrimmed
  }

  private func feedLocked(_ bytes: Data) {
    graphicsDirty = true
    let pinned = scrollOffset
    let oldLiveTop = liveTop
    let trimmedBefore = terminal.buffer.totalLinesTrimmed
    returnToLive()
    feedMarkingCommands([UInt8](bytes))
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
    graphicsDirty = true
    returnToLive()
    scrollOffset = 0
    // A reflow moves text between rows; recorded command marks no longer line up.
    commandMarks.removeAll()
    terminal.resize(cols: Int(cols), rows: Int(rows))
    liveTop = terminal.buffer.yDisp
    needsRefresh = true
  }

  private func scrollLocked(lines: Int32) {
    guard !terminal.isCurrentBufferAlternate else { return }
    let next = min(max(scrollOffset + Int(lines), 0), liveTop)
    guard next != scrollOffset else { return }
    graphicsDirty = true
    scrollOffset = next
    terminal.buffer.yDisp = liveTop - scrollOffset
    needsRefresh = true
  }

  /// Buffer-absolute rows (scrollback included) where a prompt group starts, oldest first.
  /// A prompt row always carries a mark, so unmarked rows are skipped: asking
  /// `semanticRowKind` about them walks back through continuation rows, which makes a full
  /// scan quadratic on long soft-wrapped commands. Marked rows get SwiftTerm's own answer,
  /// which also counts a secondary-prompt opener.
  private func promptRows() -> [Int] {
    let last = liveTop + terminal.getDims().rows
    return (0..<last).filter { row in
      !terminal.semanticPromptMarks(at: row).isEmpty && terminal.semanticRowKind(at: row) == .initial
    }
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
    graphicsDirty = true
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
    let group = prompts[prompts.count - 2]..<prompts[prompts.count - 1]
    let (start, end) = outputBounds(in: group, cols: cols)
    guard start.row <= end.row else { return nil }
    var rows: [(text: String, wrapped: Bool)] = []
    var sawOutput = false
    for row in start.row...end.row {
      guard let line = terminal.bufferLine(atRow: row) else { continue }
      let from = row == start.row ? start.col : 0
      let limit = min(cols, line.count, row == end.row ? end.col : cols)
      let isOutput = (0..<limit).map { col in
        col >= from && terminal.semanticContent(at: Position(col: col, row: row)) == .output
      }
      // Up to the last cell the program wrote: its trailing spaces stay, padding doesn't.
      guard let last = isOutput.lastIndex(of: true) else {
        // The rest of the command line, when C came before its newline, isn't output.
        if row == start.row, start.col > 0 { continue }
        rows.append(("", line.isWrapped))
        continue
      }
      sawOutput = true
      var text = ""
      for col in from...last {
        let data = line[col]
        if data.width == 0 { continue }
        let character = data.getText()
        text += !isOutput[col] || character.isEmpty || character == "\u{0}" ? " " : character
      }
      rows.append((text, line.isWrapped && row != start.row))
    }
    guard sawOutput else { return nil }
    var output = ""
    for (index, row) in rows.enumerated() {
      // A soft-wrapped row continues the line above; only real line breaks become newlines.
      if index > 0, !row.wrapped { output += "\n" }
      output += row.text
    }
    return output
  }

  /// Where the output of the command in `group` starts and stops (end column exclusive).
  /// From its OSC 133 C and D marks when the shell sent them; otherwise from the row after
  /// the command line to the row before the next prompt.
  private func outputBounds(in group: Range<Int>, cols: Int) -> (start: (row: Int, col: Int), end: (row: Int, col: Int)) {
    let trimmed = terminal.buffer.totalLinesTrimmed
    // The C and D between the last two prompts the shell announced (A, N or P), in the order
    // it sent them: an older D at a lower row can't be taken for this command's. SwiftTerm's
    // own prompt rows aren't used here: it keeps prompt marks on rows `clear` has wiped.
    let prompts = commandMarks.indices.filter { commandMarks[$0].kind == .prompt }
    if prompts.count >= 2 {
      let window = commandMarks[(prompts[prompts.count - 2] + 1)..<prompts[prompts.count - 1]]
      if let begin = window.first(where: { $0.kind == .outputStart }) {
        let finish = window.first { $0.kind == .outputEnd && ($0.line, $0.col) >= (begin.line, begin.col) }
        let startRow = max(0, begin.line - trimmed)
        let startCol = begin.line - trimmed < 0 ? 0 : begin.col
        // D at the start of a line ends the output on the line above; with no D, the output
        // runs to the row before the next prompt.
        let nextPrompt = commandMarks[prompts[prompts.count - 1]].line - trimmed
        let end: (row: Int, col: Int) = finish.map { $0.col == 0 ? ($0.line - trimmed - 1, cols) : ($0.line - trimmed, $0.col) }
          ?? (nextPrompt - 1, cols)
        return ((startRow, startCol), end)
      }
    }
    // No marks (a shell that sends no C, or a resize dropped them): output starts after
    // the last prompt or input cell of the command line, on that same row if it has more.
    var last: (row: Int, col: Int)?
    for row in group {
      guard let line = terminal.bufferLine(atRow: row) else { continue }
      for col in 0..<min(cols, line.count) {
        switch terminal.semanticContent(at: Position(col: col, row: row)) {
        case .prompt, .input: last = (row, col)
        default: break
        }
      }
    }
    let start = last.map { ($0.row, $0.col + 1) } ?? (group.lowerBound, 0)
    return (start, (group.upperBound - 1, cols))
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
    // An animation tick marks the screen for update without any output.
    let images = graphicsDirty || terminal.getUpdateRange() != nil
      ? TerminalImageLayer(terminal.kittyGraphicsRenderSnapshot(), owner: imageOwner)
      : cached.images
    graphicsDirty = false
    let imagesChanged = images != cached.images
    // OSC 4/104 repaint colors without touching the update range; a kitty placement or
    // delete may not touch it either.
    guard needsRefresh || stateChanged || imagesChanged || delegate.paletteChanged
      || terminal.getUpdateRange() != nil
    else { return }
    needsRefresh = false
    if delegate.paletteChanged {
      palette = TerminalPalette.table(of: terminal, fallback: theme.foreground)
      delegate.paletteChanged = false
    }
    terminal.clearUpdateRange()
    let grid = buildGrid()
    if stateChanged || imagesChanged || grid.cells != cached.cells || grid.hyperlinks != cached.hyperlinks {
      generationCounter &+= 1
    }
    var stamped = header
    stamped.generation = generationCounter
    cached = TerminalFrame(header: stamped, cells: grid.cells, hyperlinks: grid.hyperlinks, images: images)
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
    var cells = [GridSnapshot.Cell](repeating: TerminalPalette.blankCell(for: theme), count: dims.cols * dims.rows)
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
        var cell = Self.cell(data, palette: palette, theme: theme)
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

  private static func cell(_ data: CharData, palette: [UInt32], theme: TerminalTheme) -> GridSnapshot.Cell {
    let attribute = data.attribute
    var bits = attrs(attribute.style)
    // Resolved colors can't tell "never painted" from "painted the default color".
    if case .defaultColor = attribute.bg { bits |= GridSnapshot.attrDefaultBackground }
    return GridSnapshot.Cell(
      codepoint: codepoint(data),
      foreground: TerminalPalette.resolve(attribute.fg, isForeground: true, palette: palette, theme: theme),
      background: TerminalPalette.resolve(attribute.bg, isForeground: false, palette: palette, theme: theme),
      attrs: bits)
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

/// An OSC 133 mark in stream order. SwiftTerm keeps prompt marks per row but no C or D;
/// matching C and D to their prompt by order, not by row, holds across renumbering.
struct CommandMark: Equatable {
  enum Kind { case prompt, outputStart, outputEnd }
  var kind: Kind
  var line: Int
  var col: Int
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
  var cellPixelSize: (width: Int, height: Int)?

  func cellSizeInPixels(source: Terminal) -> (width: Int, height: Int)? { cellPixelSize }

  func send(source: Terminal, data: ArraySlice<UInt8>) {
    replies.append(contentsOf: data)
  }

  func showCursor(source: Terminal) { cursorVisible = true }
  func hideCursor(source: Terminal) { cursorVisible = false }
  func colorChanged(source: Terminal, idx: Int?) { paletteChanged = true }
}
