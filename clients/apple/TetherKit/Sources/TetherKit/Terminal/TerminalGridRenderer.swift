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

/// Draws the grid into a bitmap on the render queue; the main thread only assigns the `CGImage`.
/// Not thread-safe by design — one instance belongs to one serial queue.
final class TerminalGridRenderer {
  private var context: CGContext?
  private var image: CGImage?
  private var metrics: TerminalRenderMetrics?
  private var glyphCache: TerminalGlyphCache?
  private var colors: [UInt32: CGColor] = [:]
  private var glyphOffsetX: CGFloat = 0
  /// Decoded once per image content; dropped when no placement shows it any more.
  private var bitmaps: [TerminalImageLayer.Key: CGImage] = [:]

  /// Forces the next render to repaint every row (font change, resize, a new
  /// session's first frame).
  func invalidate() {
    context = nil
    image = nil
    metrics = nil
    glyphCache = nil
    colors.removeAll(keepingCapacity: true)
  }

  func render(
    header: GridSnapshot.Header,
    cells: [GridSnapshot.Cell],
    images: TerminalImageLayer = .empty,
    metrics: TerminalRenderMetrics
  ) -> CGImage? {
    let cols = Int(header.cols)
    let rows = Int(header.rows)
    guard cols > 0, rows > 0, cells.count == cols * rows else { return image }

    if self.metrics != metrics || context == nil {
      guard prepareContext(metrics) else { return nil }
    }
    guard let context, let glyphCache else { return nil }

    let drawRows = TerminalGridLayout.paintedRows(
      cells: cells, cols: cols, rows: rows, altScreen: header.altScreen, images: images
    )
    // Bottom-anchored, so a row-count change moves every row. Alt-screen trailing
    // empties are left out so they become slack at the top, not a gap under the TUI.
    let originY = max(0, metrics.size.height - CGFloat(drawRows) * metrics.cellHeight)

    guard drawRows > 0 else { return image }

    // Full repaint every frame: row-granular diffing desynced on resize and left torn
    // text. A whole grid is cheap at phone sizes and cannot drift from the cells.
    context.setFillColor(metrics.background)
    context.fill(CGRect(origin: .zero, size: metrics.size))

    // Backgrounds, then images meant to sit under text, then text, then the rest.
    for row in 0..<drawRows {
      drawBackgrounds(row: row, cols: cols, cells: cells, originY: originY, metrics: metrics, context: context)
    }
    drawImages(images, aboveText: false, originY: originY, metrics: metrics, context: context)
    for row in 0..<drawRows {
      drawGlyphs(row: row, cols: cols, cells: cells, originY: originY, metrics: metrics, glyphCache: glyphCache, context: context)
    }
    drawImages(images, aboveText: true, originY: originY, metrics: metrics, context: context)
    bitmaps = bitmaps.filter { images.bitmaps[$0.key] != nil }

    image = context.makeImage()
    return image
  }

  // MARK: - Images

  private func drawImages(
    _ layer: TerminalImageLayer, aboveText: Bool, originY: CGFloat,
    metrics: TerminalRenderMetrics, context: CGContext
  ) {
    for placement in layer.placements where placement.aboveText == aboveText {
      guard let bitmap = bitmap(for: placement.key, in: layer),
            let source = bitmap.cropping(to: CGRect(
              x: placement.sourceX, y: placement.sourceY,
              width: placement.sourceWidth, height: placement.sourceHeight))
      else { continue }
      let rect = Self.imageRect(placement, originY: originY, metrics: metrics)
      // The context is flipped to top-left; images draw y-up, so flip back around the rect.
      context.saveGState()
      context.translateBy(x: rect.minX, y: rect.maxY)
      context.scaleBy(x: 1, y: -1)
      context.interpolationQuality = .high
      context.draw(source, in: CGRect(origin: .zero, size: rect.size))
      context.restoreGState()
    }
  }

  /// The placement's cell box, with the image aspect-fit inside it from the top left: a
  /// box sized from the image's pixels is at most a cell larger than the image.
  static func imageRect(
    _ placement: TerminalImageLayer.Placement, originY: CGFloat, metrics: TerminalRenderMetrics
  ) -> CGRect {
    let offsetX = CGFloat(placement.offsetX) / metrics.scale
    let offsetY = CGFloat(placement.offsetY) / metrics.scale
    let box = CGSize(
      width: CGFloat(placement.cols) * metrics.cellWidth - offsetX,
      height: CGFloat(placement.rows) * metrics.cellHeight - offsetY
    )
    let fit = min(
      box.width / CGFloat(max(placement.sourceWidth, 1)),
      box.height / CGFloat(max(placement.sourceHeight, 1))
    )
    return CGRect(
      x: CGFloat(placement.col) * metrics.cellWidth + offsetX,
      y: originY + CGFloat(placement.row) * metrics.cellHeight + offsetY,
      width: CGFloat(placement.sourceWidth) * fit,
      height: CGFloat(placement.sourceHeight) * fit
    )
  }

  private func bitmap(for key: TerminalImageLayer.Key, in layer: TerminalImageLayer) -> CGImage? {
    if let cached = bitmaps[key] { return cached }
    guard let pixels = layer.bitmaps[key], pixels.width > 0, pixels.height > 0,
          pixels.rgba.count >= pixels.width * pixels.height * 4,
          let provider = CGDataProvider(data: Data(pixels.rgba) as CFData),
          let image = CGImage(
            width: pixels.width, height: pixels.height,
            bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: pixels.width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent
          )
    else { return nil }
    bitmaps[key] = image
    return image
  }

  // MARK: - Drawing

  private func drawBackgrounds(
    row: Int, cols: Int, cells: [GridSnapshot.Cell], originY: CGFloat,
    metrics: TerminalRenderMetrics, context: CGContext
  ) {
    let rowStart = row * cols
    let y = CGFloat(row) * metrics.cellHeight + originY
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
  }

  private func drawGlyphs(
    row: Int, cols: Int, cells: [GridSnapshot.Cell], originY: CGFloat,
    metrics: TerminalRenderMetrics, glyphCache: TerminalGlyphCache, context: CGContext
  ) {
    let rowStart = row * cols
    let y = CGFloat(row) * metrics.cellHeight + originY
    let baseline = y + (metrics.cellHeight - metrics.font.lineHeight) / 2 + metrics.font.ascender
    for run in TerminalRunBuilder.glyphRuns(cells: cells, rowStart: rowStart, cols: cols) {
      let bold = run.style & GridSnapshot.attrBold != 0
      var textColor = color(run.color)
      if run.style & GridSnapshot.attrDim != 0 {
        textColor = textColor.copy(alpha: textColor.alpha * 0.65) ?? textColor
      }
      context.setFillColor(textColor)

      // A run can mix fonts (Core Text fallback for uncovered codepoints), and glyph
      // ids only mean anything relative to their font, so flush on every font change.
      var batchFont: CTFont?
      var glyphs: [CGGlyph] = []
      var positions: [CGPoint] = []
      glyphs.reserveCapacity(run.codepoints.count)
      positions.reserveCapacity(run.codepoints.count)
      var drewAnything = false

      // CTFontDrawGlyphs positions are in TEXT space: a flipped text matrix draws at
      // -baseline, off the canvas. So flip the CTM around the baseline, glyphs at y = 0.
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
