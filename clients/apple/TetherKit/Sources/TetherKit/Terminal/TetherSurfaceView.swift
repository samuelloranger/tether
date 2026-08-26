#if canImport(UIKit)
import CoreText
import UIKit

/// CoreText terminal surface. Redraws only when the snapshot generation changes.
public final class TetherSurfaceView: UIView {
  public var fontSize: CGFloat = 14 {
    didSet { invalidateMetrics() }
  }

  public var fontName: String = ".AppleSystemUIFontMonospaced" {
    didSet { invalidateMetrics() }
  }

  /// Reports the grid size the current bounds and font can display.
  public var onGridSizeChange: ((UInt16, UInt16) -> Void)?

  /// Alacritty scroll delta: positive = into history. Built from pan pixels via
  /// `TouchScrollModel` (finger-down → history).
  public var onScrollLines: ((Int32) -> Void)?

  /// Fired when the user taps a cell (after hit-testing links / clearing selection).
  public var onTapCell: ((Int, Int) -> Void)?

  /// Double-tap word select — column/row in the visible grid.
  public var onDoubleTapCell: ((Int, Int) -> Void)?

  /// Long-press began / moved / ended for selection handles.
  public var onSelectionChanged: ((TerminalSelection?) -> Void)?

  /// Tap on a detected link target.
  public var onOpenLink: ((LinkTarget) -> Void)?

  /// When non-`.off`, pans/taps emit mouse sequences instead of scroll/select.
  public var mouseMode: MouseMode = .off
  public var mouseSgr: Bool = true
  public var onMouseBytes: ((String) -> Void)?

  public private(set) var cellWidth: CGFloat = 8
  public private(set) var cellHeight: CGFloat = 16

  public var selection: TerminalSelection? {
    didSet { setNeedsDisplay() }
  }

  private var reportedGrid: (cols: UInt16, rows: UInt16)?
  private var lastGeneration: UInt64?
  private var header: GridSnapshot.Header?
  private var cells: [GridSnapshot.Cell] = []
  private var linkSpans: [[LinkSpan]] = []

  private var font: UIFont = .monospacedSystemFont(ofSize: 14, weight: .regular)
  private var boldFont: UIFont = .monospacedSystemFont(ofSize: 14, weight: .bold)

  private var scrollRemainder: CGFloat = 0
  private var lastPanY: CGFloat = 0
  private var selectionAnchor: (row: Int, col: Int)?

  public override init(frame: CGRect) {
    super.init(frame: frame)
    commonInit()
  }

  public required init?(coder: NSCoder) {
    super.init(coder: coder)
    commonInit()
  }

  private func commonInit() {
    isOpaque = true
    backgroundColor = UIColor(red: 0.12, green: 0.12, blue: 0.18, alpha: 1)
    contentMode = .redraw
    isMultipleTouchEnabled = false
    invalidateMetrics()
    installGestures()
  }

  private func installGestures() {
    NSLog("[GESTPROBE] installGestures called, uie=\(isUserInteractionEnabled)")
    let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
    pan.maximumNumberOfTouches = 1
    addGestureRecognizer(pan)

    let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
    longPress.minimumPressDuration = 0.45
    addGestureRecognizer(longPress)

    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
    doubleTap.numberOfTapsRequired = 2
    addGestureRecognizer(doubleTap)

    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
    tap.numberOfTapsRequired = 1
    tap.require(toFail: doubleTap)
    addGestureRecognizer(tap)
  }

  /// Updates the grid from packed TGRD bytes. Skips decode and redraw when generation is unchanged.
  public func updateSnapshot(_ bytes: Data) {
    guard let decoded = try? GridSnapshotDecoder.decode(bytes) else { return }
    if lastGeneration == decoded.0.generation { return }
    lastGeneration = decoded.0.generation
    header = decoded.0
    cells = decoded.1
    rebuildLinks()
    setNeedsDisplay()
  }

  public func clearSnapshot() {
    lastGeneration = nil
    header = nil
    cells = []
    linkSpans = []
    setNeedsDisplay()
  }

  /// Plain text of each visible row (trailing spaces trimmed).
  public func rowTexts() -> [String] {
    guard let header else { return [] }
    let cols = Int(header.cols)
    let rows = Int(header.rows)
    var out: [String] = []
    out.reserveCapacity(rows)
    for row in 0..<rows {
      var line = ""
      for col in 0..<cols {
        let index = row * cols + col
        guard index < cells.count else { break }
        let cp = cells[index].codepoint
        if cp == 0 {
          line.append(" ")
        } else if let scalar = Unicode.Scalar(cp) {
          line.append(Character(scalar))
        } else {
          line.append(" ")
        }
      }
      while line.last == " " { line.removeLast() }
      out.append(line)
    }
    return out
  }

  public override var intrinsicContentSize: CGSize {
    guard let header else {
      return CGSize(width: UIView.noIntrinsicMetric, height: UIView.noIntrinsicMetric)
    }
    return CGSize(
      width: CGFloat(header.cols) * cellWidth,
      height: CGFloat(header.rows) * cellHeight
    )
  }

  public override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext(), let header else { return }

    let cols = Int(header.cols)
    let rows = Int(header.rows)

    for row in 0..<rows {
      for col in 0..<cols {
        let index = row * cols + col
        guard index < cells.count else { continue }
        let cell = cells[index]
        let x = CGFloat(col) * cellWidth
        let y = CGFloat(row) * cellHeight
        let cellRect = CGRect(x: x, y: y, width: cellWidth, height: cellHeight)

        var fg = cell.foreground
        var bg = cell.background
        if cell.attrs & GridSnapshot.attrInverse != 0 {
          swap(&fg, &bg)
        }

        context.setFillColor(colorFromARGB(bg).cgColor)
        context.fill(cellRect)

        if let selection, selection.contains(row: row, col: col) {
          context.setFillColor(UIColor.systemBlue.withAlphaComponent(0.35).cgColor)
          context.fill(cellRect)
        }

        guard cell.codepoint != 0x20, cell.codepoint != 0 else { continue }
        guard let scalar = Unicode.Scalar(cell.codepoint) else { continue }

        let useBold = cell.attrs & GridSnapshot.attrBold != 0
        let useDim = cell.attrs & GridSnapshot.attrDim != 0
        let selectedFont = useBold ? boldFont : font
        var textColor = colorFromARGB(fg)
        if useDim {
          textColor = textColor.withAlphaComponent(0.65)
        }

        let attributes: [NSAttributedString.Key: Any] = [
          .font: selectedFont,
          .foregroundColor: textColor,
          .kern: 0,
        ]
        let glyph = String(scalar)
        let attributed = NSAttributedString(string: glyph, attributes: attributes)
        let line = CTLineCreateWithAttributedString(attributed)
        let bounds = CTLineGetBoundsWithOptions(line, [])
        let drawX = x + max(0, (cellWidth - bounds.width) / 2 - bounds.origin.x)
        let drawY = y + (cellHeight - selectedFont.lineHeight) / 2 + selectedFont.ascender

        context.saveGState()
        context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        context.textPosition = CGPoint(x: drawX, y: drawY)
        CTLineDraw(line, context)

        if cell.attrs & GridSnapshot.attrUnderline != 0 {
          context.setStrokeColor(textColor.cgColor)
          context.setLineWidth(1)
          let underlineY = y + cellHeight - 2
          context.move(to: CGPoint(x: x, y: underlineY))
          context.addLine(to: CGPoint(x: x + cellWidth, y: underlineY))
          context.strokePath()
        }

        if cell.attrs & GridSnapshot.attrStrikethrough != 0 {
          context.setStrokeColor(textColor.cgColor)
          context.setLineWidth(1)
          let strikeY = y + cellHeight / 2
          context.move(to: CGPoint(x: x, y: strikeY))
          context.addLine(to: CGPoint(x: x + cellWidth, y: strikeY))
          context.strokePath()
        }

        context.restoreGState()
      }
    }

    if header.cursorVisible {
      let cursorX = CGFloat(header.cursorCol) * cellWidth
      let cursorY = CGFloat(header.cursorRow) * cellHeight
      context.setFillColor(UIColor.white.withAlphaComponent(0.35).cgColor)
      context.fill(CGRect(x: cursorX, y: cursorY, width: cellWidth, height: cellHeight))
    }

    if let selection {
      drawSelectionHandles(context: context, selection: selection.normalized)
    }
  }

  private func drawSelectionHandles(context: CGContext, selection: TerminalSelection) {
    let start = CGPoint(
      x: CGFloat(selection.startCol) * cellWidth,
      y: CGFloat(selection.startRow) * cellHeight
    )
    let end = CGPoint(
      x: CGFloat(selection.endCol + 1) * cellWidth,
      y: CGFloat(selection.endRow + 1) * cellHeight
    )
    context.setFillColor(UIColor.systemBlue.cgColor)
    context.fillEllipse(in: CGRect(x: start.x - 6, y: start.y - 6, width: 12, height: 12))
    context.fillEllipse(in: CGRect(x: end.x - 6, y: end.y - 6, width: 12, height: 12))
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    reportGridSize()
  }

  private func reportGridSize() {
    guard bounds.width > 0, bounds.height > 0, cellWidth > 0, cellHeight > 0 else { return }
    let cols = UInt16(max(1, min(500, Int(bounds.width / cellWidth))))
    let rows = UInt16(max(1, min(300, Int(bounds.height / cellHeight))))
    guard reportedGrid?.cols != cols || reportedGrid?.rows != rows else { return }
    reportedGrid = (cols, rows)
    onGridSizeChange?(cols, rows)
  }

  private func invalidateMetrics() {
    font = UIFont(name: fontName, size: fontSize)
      ?? UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    boldFont = UIFont(name: fontName, size: fontSize)
      ?? UIFont.monospacedSystemFont(ofSize: fontSize, weight: .bold)
    if let boldDescriptor = font.fontDescriptor.withSymbolicTraits(.traitBold) {
      boldFont = UIFont(descriptor: boldDescriptor, size: fontSize)
    }
    cellWidth = ceil(font.advancement(for: "M"))
    cellHeight = ceil(font.lineHeight)
    invalidateIntrinsicContentSize()
    setNeedsDisplay()
    reportGridSize()
  }

  private func rebuildLinks() {
    let texts = rowTexts()
    // TGRD has no soft-wrap flags yet — hard-wrap heuristic in LinkSpans still runs.
    let wrapped = Array(repeating: false, count: texts.count)
    linkSpans = LinkSpans.compute(texts: texts, wrapped: wrapped)
  }

  private func cellAt(_ point: CGPoint) -> (row: Int, col: Int)? {
    guard let header, cellWidth > 0, cellHeight > 0 else { return nil }
    let col = Int(point.x / cellWidth)
    let row = Int(point.y / cellHeight)
    guard col >= 0, row >= 0, col < Int(header.cols), row < Int(header.rows) else {
      return nil
    }
    return (row, col)
  }

  @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
    NSLog("[GESTPROBE] pan state=\(gesture.state.rawValue)")
    let point = gesture.location(in: self)
    if mouseMode != .off {
      handleMousePan(gesture, point: point)
      return
    }
    switch gesture.state {
    case .began:
      lastPanY = point.y
      scrollRemainder = 0
    case .changed:
      let delta = lastPanY - point.y
      lastPanY = point.y
      let result = TouchScrollModel.lines(
        deltaPixels: delta,
        remainder: scrollRemainder,
        rowHeight: cellHeight
      )
      scrollRemainder = result.remainder
      if result.lines != 0 {
        // touchScrollLines matches xterm; alacritty Delta is inverted.
        onScrollLines?(Int32(-result.lines))
      }
    case .ended, .cancelled, .failed:
      scrollRemainder = 0
    default:
      break
    }
  }

  private func handleMousePan(_ gesture: UIPanGestureRecognizer, point: CGPoint) {
    guard let header else { return }
    let cell = MouseSeq.cellFromPoint(
      x: point.x, y: point.y, bounds: bounds,
      cols: Int(header.cols), rows: Int(header.rows),
      cellWidth: cellWidth, cellHeight: cellHeight
    )
    switch gesture.state {
    case .began:
      lastPanY = point.y
      scrollRemainder = 0
      onMouseBytes?(MouseSeq.pressSeq(col: cell.col, row: cell.row, sgr: mouseSgr))
    case .changed:
      if let motion = MouseSeq.motionSeq(
        col: cell.col, row: cell.row, mode: mouseMode, sgr: mouseSgr
      ) {
        onMouseBytes?(motion)
      }
      let delta = lastPanY - point.y
      lastPanY = point.y
      let result = TouchScrollModel.lines(
        deltaPixels: delta, remainder: scrollRemainder, rowHeight: cellHeight
      )
      scrollRemainder = result.remainder
      if result.lines != 0 {
        let up = result.lines < 0
        for _ in 0..<abs(result.lines) {
          onMouseBytes?(MouseSeq.wheelSeq(up: up, col: cell.col, row: cell.row, sgr: mouseSgr))
        }
      }
    case .ended, .cancelled, .failed:
      if let rel = MouseSeq.releaseSeq(
        col: cell.col, row: cell.row, mode: mouseMode, sgr: mouseSgr
      ) {
        onMouseBytes?(rel)
      }
      scrollRemainder = 0
    default:
      break
    }
  }

  @objc private func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
    if mouseMode != .off { return }
    let point = gesture.location(in: self)
    guard let cell = cellAt(point) else { return }
    switch gesture.state {
    case .began:
      selectionAnchor = cell
      selection = TerminalSelection(
        startRow: cell.row, startCol: cell.col, endRow: cell.row, endCol: cell.col
      )
      onSelectionChanged?(selection)
    case .changed:
      if let anchor = selectionAnchor {
        selection = TerminalSelection(
          startRow: anchor.row, startCol: anchor.col, endRow: cell.row, endCol: cell.col
        )
        onSelectionChanged?(selection)
      }
    case .ended, .cancelled, .failed:
      selectionAnchor = nil
      onSelectionChanged?(selection)
    default:
      break
    }
  }

  @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
    let point = gesture.location(in: self)
    guard let cell = cellAt(point) else { return }

    if mouseMode != .off {
      let oneBasedCol = cell.col + 1
      let oneBasedRow = cell.row + 1
      for seq in MouseSeq.clickSeqs(
        col: oneBasedCol, row: oneBasedRow, mode: mouseMode, sgr: mouseSgr
      ) {
        onMouseBytes?(seq)
      }
      return
    }

    if let target = LinkSpans.target(atColumn: cell.col, row: cell.row, spans: linkSpans) {
      onOpenLink?(target)
      return
    }

    if selection != nil {
      selection = nil
      onSelectionChanged?(nil)
    }
    onTapCell?(cell.col, cell.row)
  }

  @objc private func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
    if mouseMode != .off { return }
    let point = gesture.location(in: self)
    guard let cell = cellAt(point) else { return }
    let rows = rowTexts()
    guard cell.row < rows.count else { return }
    if let bounds = WordAt.bounds(atColumn: cell.col, in: rows[cell.row]) {
      selection = TerminalSelection(
        startRow: cell.row, startCol: bounds.start,
        endRow: cell.row, endCol: bounds.end
      )
      onSelectionChanged?(selection)
    }
    onDoubleTapCell?(cell.col, cell.row)
  }

  private func colorFromARGB(_ argb: UInt32) -> UIColor {
    let a = CGFloat((argb >> 24) & 0xFF) / 255
    let r = CGFloat((argb >> 16) & 0xFF) / 255
    let g = CGFloat((argb >> 8) & 0xFF) / 255
    let b = CGFloat(argb & 0xFF) / 255
    return UIColor(red: r, green: g, blue: b, alpha: a == 0 ? 1 : a)
  }
}

private extension UIFont {
  func advancement(for character: String) -> CGFloat {
    let attrs: [NSAttributedString.Key: Any] = [.font: self]
    return (character as NSString).size(withAttributes: attrs).width
  }
}

#endif
