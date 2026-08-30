#if canImport(UIKit)
import CoreGraphics
import CoreText
import UIKit

/// How the grid maps onto pixels. Changing any of it invalidates the bitmap.
struct TerminalRenderMetrics: Equatable {
  var cellWidth: CGFloat
  var cellHeight: CGFloat
  /// View size in points.
  var size: CGSize
  var scale: CGFloat
  var font: UIFont
  var boldFont: UIFont
  var background: CGColor

  /// Hand-written so the comparison never depends on whether the CoreGraphics
  /// overlay gives `CGColor` an `Equatable` conformance.
  static func == (lhs: TerminalRenderMetrics, rhs: TerminalRenderMetrics) -> Bool {
    lhs.cellWidth == rhs.cellWidth
      && lhs.cellHeight == rhs.cellHeight
      && lhs.size == rhs.size
      && lhs.scale == rhs.scale
      && lhs.font == rhs.font
      && lhs.boldFont == rhs.boldFont
      && CFEqual(lhs.background, rhs.background)
  }
}

/// Draws the grid into a retained bitmap, off the main thread, repainting only
/// the rows that changed.
///
/// The surface used to render inside `UIView.draw(_:)`, which meant the whole
/// grid was re-shaped on the main thread every time a single character
/// arrived. Everything here runs on the render queue and hands back a
/// `CGImage` for the text layer's `contents`; the main thread's only job is to
/// assign it.
///
/// Not thread-safe by design — one instance belongs to one serial queue.
final class TerminalGridRenderer {
  private var context: CGContext?
  private var image: CGImage?
  private var metrics: TerminalRenderMetrics?
  private var glyphCache: TerminalGlyphCache?
  private var colors: [UInt32: CGColor] = [:]
  private var glyphOffsetX: CGFloat = 0

  private var lastCells: [GridSnapshot.Cell] = []
  private var lastCols = 0
  private var lastRows = 0
  private var lastOriginY: CGFloat = 0

  /// Forces the next render to repaint every row (font change, resize, a new
  /// session's first frame).
  func invalidate() {
    context = nil
    image = nil
    metrics = nil
    glyphCache = nil
    colors.removeAll(keepingCapacity: true)
    lastCells = []
    lastCols = 0
    lastRows = 0
  }

  func render(
    header: GridSnapshot.Header,
    cells: [GridSnapshot.Cell],
    metrics: TerminalRenderMetrics
  ) -> CGImage? {
    let cols = Int(header.cols)
    let rows = Int(header.rows)
    guard cols > 0, rows > 0, cells.count == cols * rows else { return image }

    var repaintAll = false
    if self.metrics != metrics || context == nil {
      guard prepareContext(metrics) else { return nil }
      repaintAll = true
    }
    guard let context, let glyphCache else { return nil }

    // The grid is anchored to the bottom of the view (newest output nearest the
    // key bar), so a row-count change moves every row on screen.
    let originY = max(0, metrics.size.height - CGFloat(rows) * metrics.cellHeight)
    if cols != lastCols || rows != lastRows || originY != lastOriginY {
      repaintAll = true
    }

    let dirty: [Int]
    if repaintAll {
      dirty = Array(0..<rows)
    } else if let changed = GridDiff.dirtyRows(
      previous: lastCells, current: cells, cols: cols, rows: rows
    ) {
      dirty = changed
    } else {
      dirty = Array(0..<rows)
    }

    lastCells = cells
    lastCols = cols
    lastRows = rows
    lastOriginY = originY

    if dirty.isEmpty { return image }

    if repaintAll {
      context.setFillColor(metrics.background)
      context.fill(CGRect(origin: .zero, size: metrics.size))
    }

    for row in dirty {
      draw(
        row: row, cols: cols, cells: cells, originY: originY,
        metrics: metrics, glyphCache: glyphCache, context: context,
        clearFirst: !repaintAll
      )
    }

    image = context.makeImage()
    return image
  }

  // MARK: - Drawing

  private func draw(
    row: Int,
    cols: Int,
    cells: [GridSnapshot.Cell],
    originY: CGFloat,
    metrics: TerminalRenderMetrics,
    glyphCache: TerminalGlyphCache,
    context: CGContext,
    clearFirst: Bool
  ) {
    let rowStart = row * cols
    let y = CGFloat(row) * metrics.cellHeight + originY
    let rowRect = CGRect(
      x: 0, y: y,
      width: CGFloat(cols) * metrics.cellWidth,
      height: metrics.cellHeight
    )

    if clearFirst {
      // The bitmap is retained between frames, so a repainted row has to be
      // cleared or the old glyphs bleed through the new ones.
      context.setFillColor(metrics.background)
      context.fill(rowRect)
    }

    for span in TerminalRunBuilder.backgrounds(cells: cells, rowStart: rowStart, cols: cols) {
      context.setFillColor(color(span.color))
      context.fill(
        CGRect(
          x: CGFloat(span.startCol) * metrics.cellWidth,
          y: y,
          width: CGFloat(span.length) * metrics.cellWidth,
          height: metrics.cellHeight
        )
      )
    }

    let baseline = y + (metrics.cellHeight - metrics.font.lineHeight) / 2 + metrics.font.ascender
    for run in TerminalRunBuilder.glyphRuns(cells: cells, rowStart: rowStart, cols: cols) {
      let bold = run.style & GridSnapshot.attrBold != 0
      var textColor = color(run.color)
      if run.style & GridSnapshot.attrDim != 0 {
        textColor = textColor.copy(alpha: textColor.alpha * 0.65) ?? textColor
      }
      context.setFillColor(textColor)

      // A run shares a colour and a style, but not necessarily a FONT: a
      // codepoint the terminal face cannot draw comes back from the cache on
      // whatever fallback Core Text picked for it. Glyph ids only mean anything
      // relative to their own font, so the run is flushed at every font change.
      var batchFont: CTFont?
      var glyphs: [CGGlyph] = []
      var positions: [CGPoint] = []
      glyphs.reserveCapacity(run.codepoints.count)
      positions.reserveCapacity(run.codepoints.count)
      var drewAnything = false

      // CTFontDrawGlyphs takes positions in TEXT space, which the text matrix
      // then maps into user space — unlike CTLineDraw, which anchors on
      // `context.textPosition` in user space. Under the flipped text matrix
      // this originally carried, a glyph asked for at `baseline` was drawn at
      // `-baseline`: every glyph landed above the top of the canvas and the
      // terminal rendered nothing but its cursor.
      //
      // So the flip is done explicitly here instead, around the baseline, with
      // an identity text matrix and glyphs at y = 0. The whole run shares one
      // baseline, so this is one save/restore per run rather than per glyph.
      func flush() {
        guard let batchFont, !glyphs.isEmpty else { return }
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: 0, y: baseline)
        context.scaleBy(x: 1, y: -1)
        CTFontDrawGlyphs(batchFont, glyphs, positions, glyphs.count, context)
        context.restoreGState()
        glyphs.removeAll(keepingCapacity: true)
        positions.removeAll(keepingCapacity: true)
      }

      for (offset, codepoint) in run.codepoints.enumerated() {
        guard let resolved = glyphCache.glyph(for: codepoint, bold: bold) else { continue }
        if let current = batchFont, !CFEqual(current, resolved.font) { flush() }
        batchFont = resolved.font
        glyphs.append(resolved.glyph)
        // y is 0 because `flush` has already translated to the baseline.
        positions.append(
          CGPoint(
            x: CGFloat(run.startCol + offset) * metrics.cellWidth + glyphOffsetX,
            y: 0
          )
        )
        drewAnything = true
      }
      flush()
      guard drewAnything else { continue }

      let runWidth = CGFloat(run.codepoints.count) * metrics.cellWidth
      let runX = CGFloat(run.startCol) * metrics.cellWidth
      if run.style & GridSnapshot.attrUnderline != 0 {
        stroke(
          context: context, color: textColor,
          from: CGPoint(x: runX, y: y + metrics.cellHeight - 2),
          to: CGPoint(x: runX + runWidth, y: y + metrics.cellHeight - 2)
        )
      }
      if run.style & GridSnapshot.attrStrikethrough != 0 {
        stroke(
          context: context, color: textColor,
          from: CGPoint(x: runX, y: y + metrics.cellHeight / 2),
          to: CGPoint(x: runX + runWidth, y: y + metrics.cellHeight / 2)
        )
      }
    }
  }

  private func stroke(context: CGContext, color: CGColor, from: CGPoint, to: CGPoint) {
    context.setStrokeColor(color)
    context.setLineWidth(1)
    context.beginPath()
    context.move(to: from)
    context.addLine(to: to)
    context.strokePath()
  }

  // MARK: - Setup

  private func prepareContext(_ metrics: TerminalRenderMetrics) -> Bool {
    let width = Int((metrics.size.width * metrics.scale).rounded())
    let height = Int((metrics.size.height * metrics.scale).rounded())
    guard width > 0, height > 0 else { return false }

    guard
      let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
          | CGBitmapInfo.byteOrder32Little.rawValue
      )
    else { return false }

    // Bitmap contexts are y-up; flip so every coordinate below is the same
    // top-left-origin geometry the grid and the gestures already use.
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: metrics.scale, y: -metrics.scale)
    context.setAllowsAntialiasing(true)
    context.setShouldSmoothFonts(false)
    context.setShouldSubpixelPositionFonts(true)

    let cache = TerminalGlyphCache(regular: metrics.font, bold: metrics.boldFont)
    self.context = context
    self.metrics = metrics
    glyphCache = cache
    colors.removeAll(keepingCapacity: true)
    lastCells = []
    lastCols = 0
    lastRows = 0
    glyphOffsetX = Self.horizontalInset(cellWidth: metrics.cellWidth, cache: cache)
    return true
  }

  /// The grid is monospaced, so one measurement centres every glyph.
  private static func horizontalInset(cellWidth: CGFloat, cache: TerminalGlyphCache) -> CGFloat {
    guard let resolved = cache.glyph(for: 0x4D, bold: false) else { return 0 }
    var glyphs = [resolved.glyph]
    var advances = [CGSize.zero]
    _ = CTFontGetAdvancesForGlyphs(cache.regular, .horizontal, &glyphs, &advances, 1)
    return max(0, (cellWidth - advances[0].width) / 2)
  }

  private func color(_ argb: UInt32) -> CGColor {
    if let cached = colors[argb] { return cached }
    let a = CGFloat((argb >> 24) & 0xFF) / 255
    let r = CGFloat((argb >> 16) & 0xFF) / 255
    let g = CGFloat((argb >> 8) & 0xFF) / 255
    let b = CGFloat(argb & 0xFF) / 255
    let color = UIColor(red: r, green: g, blue: b, alpha: a == 0 ? 1 : a).cgColor
    colors[argb] = color
    return color
  }
}
#endif
