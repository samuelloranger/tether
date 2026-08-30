#if canImport(UIKit)
import CoreGraphics
import CoreText
import SwiftUI
import UIKit

/// CoreText terminal surface.
///
/// The view itself no longer draws. A display link pulls the newest snapshot
/// once per vsync, a serial queue decodes and rasterizes it into a retained
/// bitmap, and the main thread only assigns the resulting image to a layer.
/// Cursor and selection live on their own layers so neither one re-runs any
/// text drawing.
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
    didSet {
      guard selection != oldValue else { return }
      updateSelectionLayers()
    }
  }

  private var reportedGrid: (cols: UInt16, rows: UInt16)?
  /// Coalesces grid-size reports so only a SETTLED size reaches the emulator and
  /// the PTY. A keyboard animation drives layoutSubviews once per frame, and the
  /// intermediate heights include very short ones. Each report used to resize
  /// both sides immediately, and a resize down to a handful of rows destroys a
  /// full-screen TUI's screen for good — when the view settled the rows came
  /// back but the content did not, leaving a few lines and blank space.
  private var gridSettleWork: DispatchWorkItem?
  private var header: GridSnapshot.Header?
  private var cells: [GridSnapshot.Cell] = []
  private var cachedRowTexts: [String] = []
  private var linkSpans: [[LinkSpan]] = []

  private var font: UIFont = .monospacedSystemFont(ofSize: 14, weight: .regular)
  private var boldFont: UIFont = .monospacedSystemFont(ofSize: 14, weight: .bold)

  private var scrollRemainder: CGFloat = 0
  private var lastPanY: CGFloat = 0
  private var selectionAnchor: (row: Int, col: Int)?

  // MARK: - Layers

  /// Holds every content layer so a pan can translate all of them at once.
  private let contentLayer = CALayer()
  private let textLayer = CALayer()
  private let selectionLayer = CAShapeLayer()
  private let cursorLayer = CALayer()
  private let startHandleLayer = CALayer()
  private let endHandleLayer = CALayer()

  // MARK: - Frame pipeline

  private let renderQueue = DispatchQueue(label: "cloud.samlo.tether.surface-render", qos: .userInteractive)
  private let worker = TerminalRenderWorker()
  private var scheduler: TerminalFrameScheduler?
  private var pendingSnapshot: Data?
  private var needsRepaint = false
  private var isRendering = false
  /// Bumped whenever the surface's contents stop being the ones a render was
  /// started for. A render already in flight completes anyway — the queue has
  /// no cancellation — and its `commit` would otherwise repopulate the layers
  /// with the session that was just cleared.
  private var frameEpoch: UInt64 = 0

  public override init(frame: CGRect) {
    super.init(frame: frame)
    commonInit()
  }

  public required init?(coder: NSCoder) {
    super.init(coder: coder)
    commonInit()
  }

  deinit {
    scheduler?.stop()
  }

  private func commonInit() {
    isOpaque = true
    // Same constant the SwiftUI chrome uses, so the grid and everything around
    // it are one colour rather than two that nearly match.
    backgroundColor = UIColor(TetherColors.terminalBackground)
    isMultipleTouchEnabled = false
    installLayers()
    scheduler = TerminalFrameScheduler { [weak self] in
      self?.pumpFrame() ?? false
    }
    invalidateMetrics()
    installGestures()
  }

  private func installLayers() {
    contentLayer.masksToBounds = true
    layer.addSublayer(contentLayer)

    textLayer.contentsGravity = .topLeft
    textLayer.contentsScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
    textLayer.isOpaque = true
    contentLayer.addSublayer(textLayer)

    selectionLayer.fillColor = UIColor.systemBlue.withAlphaComponent(0.35).cgColor
    selectionLayer.strokeColor = nil
    selectionLayer.isHidden = true
    contentLayer.addSublayer(selectionLayer)

    cursorLayer.backgroundColor = UIColor.white.withAlphaComponent(0.35).cgColor
    cursorLayer.isHidden = true
    contentLayer.addSublayer(cursorLayer)

    for handle in [startHandleLayer, endHandleLayer] {
      handle.backgroundColor = UIColor.systemBlue.cgColor
      handle.cornerRadius = 6
      handle.bounds = CGRect(x: 0, y: 0, width: 12, height: 12)
      handle.isHidden = true
      contentLayer.addSublayer(handle)
    }
  }

  private func installGestures() {
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

  // MARK: - Snapshot intake

  /// Hands the newest packed TGRD bytes to the frame pump.
  ///
  /// Deliberately does no work: decoding here meant one decode per WebSocket
  /// frame, most of them discarded before the next vsync.
  public func updateSnapshot(_ bytes: Data) {
    pendingSnapshot = bytes
    scheduler?.requestFrame()
  }

  public func clearSnapshot() {
    frameEpoch &+= 1
    // An in-flight render will still call commit; it is discarded there, so the
    // pump has to be released here or the next frame never starts.
    isRendering = false
    pendingSnapshot = nil
    needsRepaint = false
    header = nil
    cells = []
    cachedRowTexts = []
    linkSpans = []
    renderQueue.async { [worker] in
      worker.reset()
    }
    withoutAnimations {
      textLayer.contents = nil
      cursorLayer.isHidden = true
      selectionLayer.isHidden = true
      startHandleLayer.isHidden = true
      endHandleLayer.isHidden = true
      contentLayer.setAffineTransform(.identity)
    }
  }

  /// Plain text of each visible row (trailing spaces trimmed).
  public func rowTexts() -> [String] {
    cachedRowTexts
  }

  // MARK: - Frame pump

  /// One display-link tick. Returns whether it had work to do.
  private func pumpFrame() -> Bool {
    if isRendering { return true }
    let bytes = pendingSnapshot
    guard bytes != nil || needsRepaint else { return false }
    guard let metrics = currentMetrics() else { return false }

    pendingSnapshot = nil
    needsRepaint = false
    isRendering = true

    let epoch = frameEpoch
    renderQueue.async { [weak self, worker] in
      let output: TerminalRenderOutput?
      if let bytes {
        output = worker.render(bytes: bytes, metrics: metrics)
      } else {
        output = worker.rerender(metrics: metrics)
      }
      DispatchQueue.main.async {
        self?.commit(output, epoch: epoch)
      }
    }
    return true
  }

  private func commit(_ output: TerminalRenderOutput?, epoch: UInt64) {
    // Rendered for contents the surface has since dropped. `isRendering` was
    // already cleared by whoever bumped the epoch.
    guard epoch == frameEpoch else { return }
    isRendering = false
    defer {
      if pendingSnapshot != nil || needsRepaint { scheduler?.requestFrame() }
    }
    guard let output else { return }

    header = output.header
    cells = output.cells
    cachedRowTexts = output.rowTexts
    linkSpans = output.linkSpans

    withoutAnimations {
      if let image = output.image {
        textLayer.frame = bounds
        textLayer.contents = image
      }
      // The grid now reflects every line the pan sent, so the sub-cell offset
      // that stood in for them is spent.
      contentLayer.setAffineTransform(.identity)
      updateCursorLayer()
      updateSelectionLayers()
    }
    invalidateIntrinsicContentSize()
  }

  private func currentMetrics() -> TerminalRenderMetrics? {
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    let scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
    return TerminalRenderMetrics(
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      size: bounds.size,
      scale: scale,
      font: font,
      boldFont: boldFont,
      background: (backgroundColor ?? .black).cgColor
    )
  }

  private func requestRepaint() {
    needsRepaint = true
    scheduler?.requestFrame()
  }

  /// Layer geometry changes must not animate: an implicit 0.25s CABasicAnimation
  /// on `contents` turns every terminal frame into a cross-fade.
  private func withoutAnimations(_ body: () -> Void) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    body()
    CATransaction.commit()
  }

  // MARK: - Cursor and selection layers

  private func updateCursorLayer() {
    guard let header, header.cursorVisible else {
      cursorLayer.isHidden = true
      return
    }
    cursorLayer.isHidden = false
    cursorLayer.frame = CGRect(
      x: CGFloat(header.cursorCol) * cellWidth,
      y: CGFloat(header.cursorRow) * cellHeight + gridOriginY,
      width: cellWidth,
      height: cellHeight
    )
  }

  private func updateSelectionLayers() {
    guard let selection, let header else {
      withoutAnimations {
        selectionLayer.isHidden = true
        startHandleLayer.isHidden = true
        endHandleLayer.isHidden = true
      }
      return
    }
    let normalized = selection.normalized
    let path = CGMutablePath()
    let cols = Int(header.cols)
    let rows = Int(header.rows)
    let originY = gridOriginY

    for row in max(0, normalized.startRow)...max(0, normalized.endRow) where row < rows {
      var first: Int?
      var last: Int?
      for col in 0..<cols where normalized.contains(row: row, col: col) {
        if first == nil { first = col }
        last = col
      }
      guard let first, let last else { continue }
      path.addRect(
        CGRect(
          x: CGFloat(first) * cellWidth,
          y: CGFloat(row) * cellHeight + originY,
          width: CGFloat(last - first + 1) * cellWidth,
          height: cellHeight
        )
      )
    }

    withoutAnimations {
      selectionLayer.frame = bounds
      selectionLayer.path = path
      selectionLayer.isHidden = path.isEmpty
      startHandleLayer.isHidden = false
      endHandleLayer.isHidden = false
      startHandleLayer.position = CGPoint(
        x: CGFloat(normalized.startCol) * cellWidth,
        y: CGFloat(normalized.startRow) * cellHeight + originY
      )
      endHandleLayer.position = CGPoint(
        x: CGFloat(normalized.endCol + 1) * cellWidth,
        y: CGFloat(normalized.endRow + 1) * cellHeight + originY
      )
    }
  }

  // MARK: - Geometry

  public override var intrinsicContentSize: CGSize {
    guard let header else {
      return CGSize(width: UIView.noIntrinsicMetric, height: UIView.noIntrinsicMetric)
    }
    return CGSize(
      width: CGFloat(header.cols) * cellWidth,
      height: CGFloat(header.rows) * cellHeight
    )
  }

  /// Vertical offset that anchors the grid to the BOTTOM of the view.
  ///
  /// The grid is a whole number of rows, so it is almost never exactly the view's
  /// height, and a resize round-trip can leave the emulator a few rows short of
  /// what fits. Drawing from the top put that slack between the last line and the
  /// key bar, where it reads as a gap in the content. A terminal's newest output
  /// is at the bottom, so anchoring there moves the slack up against the title
  /// bar, where it is indistinguishable from empty scrollback.
  private var gridOriginY: CGFloat {
    guard let header else { return 0 }
    let drawn = CGFloat(header.rows) * cellHeight
    return max(0, bounds.height - drawn)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    withoutAnimations {
      contentLayer.frame = bounds
      textLayer.frame = bounds
      textLayer.contentsScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
    }
    reportGridSize()
    requestRepaint()
  }

  public override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    guard traitCollection.displayScale != previous?.displayScale else { return }
    requestRepaint()
  }

  private func reportGridSize() {
    guard let size = currentGridSize() else { return }
    guard reportedGrid?.cols != size.cols || reportedGrid?.rows != size.rows else { return }

    // The very first size is sent straight through, so connecting is not delayed
    // by the settle window.
    if reportedGrid == nil {
      commitGridSize(size)
      return
    }

    gridSettleWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      // Re-derive from the CURRENT bounds rather than trusting the size that
      // scheduled this, so a transient frame can never be what gets committed.
      guard let settled = self.currentGridSize() else { return }
      guard self.reportedGrid?.cols != settled.cols || self.reportedGrid?.rows != settled.rows
      else { return }
      self.commitGridSize(settled)
    }
    gridSettleWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.gridSettleDelay, execute: work)
  }

  /// Long enough to outlast a keyboard show/hide animation (~0.25s on iOS), short
  /// enough that a deliberate window resize still feels immediate.
  private static let gridSettleDelay: TimeInterval = 0.3

  private func currentGridSize() -> (cols: UInt16, rows: UInt16)? {
    guard bounds.width > 0, bounds.height > 0, cellWidth > 0, cellHeight > 0 else { return nil }
    return (
      UInt16(max(1, min(500, Int(bounds.width / cellWidth)))),
      UInt16(max(1, min(300, Int(bounds.height / cellHeight))))
    )
  }

  private func commitGridSize(_ size: (cols: UInt16, rows: UInt16)) {
    reportedGrid = size
    onGridSizeChange?(size.cols, size.rows)
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
    requestRepaint()
    reportGridSize()
  }

  private func cellAt(_ point: CGPoint) -> (row: Int, col: Int)? {
    guard let header, cellWidth > 0, cellHeight > 0 else { return nil }
    let col = Int(point.x / cellWidth)
    let row = Int((point.y - gridOriginY) / cellHeight)
    guard col >= 0, row >= 0, col < Int(header.cols), row < Int(header.rows) else {
      return nil
    }
    return (row, col)
  }

  // MARK: - Gestures

  @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
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
      applyScrollOffset()
    case .ended, .cancelled, .failed:
      scrollRemainder = 0
      applyScrollOffset()
    default:
      break
    }
  }

  /// Tracks the finger through the part of a drag that has not yet become a
  /// whole row.
  ///
  /// Scrolling only ever moved in cell-height steps, and each step waited for
  /// the emulator to send a new grid — so the content visibly lagged the touch.
  /// The leftover pixels are exactly the distance the grid does not know about
  /// yet, so shifting the content layer by them costs nothing (it is a
  /// compositor transform, not a redraw) and makes the drag track 1:1.
  private func applyScrollOffset() {
    withoutAnimations {
      // `scrollRemainder` carries the sign of `lastPanY - point.y`, so a finger
      // moving DOWN produces a negative remainder while the content it drags
      // has to move DOWN — hence the negation.
      contentLayer.setAffineTransform(CGAffineTransform(translationX: 0, y: -scrollRemainder))
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
}

private extension UIFont {
  func advancement(for character: String) -> CGFloat {
    let attrs: [NSAttributedString.Key: Any] = [.font: self]
    return (character as NSString).size(withAttributes: attrs).width
  }
}

#endif
