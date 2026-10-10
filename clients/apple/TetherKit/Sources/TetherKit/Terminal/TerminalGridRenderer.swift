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
  /// The theme's cursor colour; OSC 12 in the frame header wins. Left out of `==`: it only
  /// colours the cursor cell, never the grid.
  var cursor: UInt32 = 0xFFFF_FFFF

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
  private var dimColors: [UInt32: CGColor] = [:]
  private var glyphOffsetX: CGFloat = 0
  /// Reused across runs and frames instead of two fresh arrays per glyph run.
  private var glyphBuffer: [CGGlyph] = []
  private var positionBuffer: [CGPoint] = []
  /// What the bitmap shows now, so the next frame repaints only the rows that differ.
  private var paintedCells: [GridSnapshot.Cell] = []
  private var paintedClusters: [Int: String] = [:]
  private var paintedOriginY: CGFloat = -1
  private var paintedSize: (cols: Int, rows: Int) = (0, 0)
  /// Rows the last partial render repainted.
  private(set) var repaintedRows = 0
  private var paintedBackground: UInt32?
  /// Rows anchored to the bottom in the last render.
  private(set) var drawRows = 0
  /// Decoded once per image content; dropped when no placement shows it any more.
  private var bitmaps: [TerminalImageLayer.Key: CGImage] = [:]
  /// Whether `image` shows any kitty placement: an empty frame may keep a stale bitmap,
  /// but not one with a deleted image still on it.
  private var imageShowsPlacements = false

  /// Forces the next render to repaint every row (font change, resize, a new
  /// session's first frame).
  func invalidate() {
    context = nil
    image = nil
    imageShowsPlacements = false
    metrics = nil
    glyphCache = nil
    colors.removeAll(keepingCapacity: true)
    dimColors.removeAll(keepingCapacity: true)
    paintedCells = []
    paintedClusters = [:]
    paintedOriginY = -1
  }

  /// Colours are given in sRGB, which is also what the chrome around the grid is in.
  static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

  func render(
    header: GridSnapshot.Header,
    cells: [GridSnapshot.Cell],
    images: TerminalImageLayer = .empty,
    clusters: [Int: String] = [:],
    defaultBackground: UInt32? = nil,
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
      cells: cells, cols: cols, rows: rows, altScreen: header.altScreen && header.trimsBlankRows, images: images
    )
    self.drawRows = drawRows
    let fill = defaultBackground.map(color) ?? metrics.background
    // Bottom-anchored, so a row-count change moves every row. Alt-screen trailing
    // empties are left out so they become slack at the top, not a gap under the TUI.
    let originY = max(0, metrics.size.height - CGFloat(drawRows) * metrics.cellHeight)

    guard drawRows > 0 || imageShowsPlacements else { return image }

    // Same geometry and no images on either frame: only rows whose cells changed are
    // repainted, each clipped to its own band. Anything else repaints the whole bitmap, which
    // is also what keeps a resize from leaving torn rows behind.
    if images.isEmpty, !imageShowsPlacements, originY == paintedOriginY, paintedCells.count == cells.count,
      paintedSize == (cols, rows), paintedBackground == defaultBackground {
      var clusterRows = Set<Int>()
      if clusters != paintedClusters {
        for key in Set(clusters.keys).union(paintedClusters.keys) where clusters[key] != paintedClusters[key] {
          clusterRows.insert(key / cols)
        }
      }
      repaintedRows = 0
      for row in 0..<drawRows {
        let range = (row * cols)..<((row + 1) * cols)
        guard cells[range] != paintedCells[range] || clusterRows.contains(row) else { continue }
        repaintedRows += 1
        paintRow(
          row, cols: cols, cells: cells, clusters: clusters, fill: fill, originY: originY, metrics: metrics,
          glyphCache: glyphCache, context: context)
      }
      paintedCells = cells
      paintedClusters = clusters
      image = context.makeImage()
      return image
    }

    context.setFillColor(fill)
    context.fill(CGRect(origin: .zero, size: metrics.size))

    // Kitty's order: images under the backgrounds, cell backgrounds, images under the text,
    // text, then everything else.
    drawImages(images, depth: .belowBackground, originY: originY, metrics: metrics, context: context)
    // With an image under them, cells that were never given a background stay see-through,
    // as in kitty; the fill above already painted the default color everywhere else. A cell
    // a program painted, even in the default color, still covers the image.
    let seeThrough = images.placements.contains { $0.depth == .belowBackground }
    let backgroundCells = seeThrough ? cells.map(Self.clearingDefaultBackground) : cells
    for row in 0..<drawRows {
      drawBackgrounds(
        row: row, cols: cols, cells: backgroundCells, originY: originY, metrics: metrics, context: context,
        skipping: seeThrough ? Self.transparent : nil
      )
    }
    drawImages(images, depth: .belowText, originY: originY, metrics: metrics, context: context)
    for row in 0..<drawRows {
      clipped(toRow: row, originY: originY, metrics: metrics, context: context) {
        drawGlyphs(
          row: row, cols: cols, cells: cells, clusters: clusters, originY: originY, metrics: metrics,
          glyphCache: glyphCache, context: context)
      }
    }
    drawImages(images, depth: .aboveText, originY: originY, metrics: metrics, context: context)
    if !bitmaps.isEmpty { bitmaps = bitmaps.filter { images.bitmaps[$0.key] != nil } }
    imageShowsPlacements = !images.isEmpty
    paintedCells = cells
    paintedClusters = clusters
    paintedOriginY = originY
    paintedSize = (cols, rows)
    repaintedRows = drawRows
    paintedBackground = defaultBackground

    image = context.makeImage()
    return image
  }

  private func paintRow(
    _ row: Int, cols: Int, cells: [GridSnapshot.Cell], clusters: [Int: String], fill: CGColor, originY: CGFloat,
    metrics: TerminalRenderMetrics, glyphCache: TerminalGlyphCache, context: CGContext
  ) {
    let band = CGRect(x: 0, y: CGFloat(row) * metrics.cellHeight + originY, width: metrics.size.width, height: metrics.cellHeight)
    context.setFillColor(fill)
    context.fill(band)
    drawBackgrounds(row: row, cols: cols, cells: cells, originY: originY, metrics: metrics, context: context)
    clipped(toRow: row, originY: originY, metrics: metrics, context: context) {
      drawGlyphs(
        row: row, cols: cols, cells: cells, clusters: clusters, originY: originY, metrics: metrics,
        glyphCache: glyphCache, context: context)
    }
  }

  /// The cell under a block cursor, drawn solid with its glyph in the cell's background colour
  /// (the way a terminal inverts it), so text under the cursor stays readable on any theme.
  func cursorImage(
    header: GridSnapshot.Header, cells: [GridSnapshot.Cell], clusters: [Int: String], metrics: TerminalRenderMetrics
  ) -> CGImage? {
    let index = Int(header.cursorRow) * Int(header.cols) + Int(header.cursorCol)
    guard cells.indices.contains(index) else { return nil }
    let span: CGFloat = header.cursorWide ? 2 : 1
    let size = CGSize(width: metrics.cellWidth * span, height: metrics.cellHeight)
    let width = Int((size.width * metrics.scale).rounded())
    let height = Int((size.height * metrics.scale).rounded())
    guard width > 0, height > 0, let glyphCache,
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: Self.colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: metrics.scale, y: -metrics.scale)
    context.setFillColor(color(header.cursorColor ?? metrics.cursor))
    context.fill(CGRect(origin: .zero, size: size))
    let cell = cells[index]
    if !TerminalRunBuilder.isBlank(cell) || clusters[index] != nil {
      let ink = color(TerminalRunBuilder.resolved(cell).bg)
      drawCell(
        cell, cluster: clusters[index], in: CGRect(origin: .zero, size: size), color: ink,
        metrics: metrics, glyphCache: glyphCache, context: context)
    }
    return context.makeImage()
  }

  /// A row's glyphs stay inside its band on every path, so repainting one row alone never
  /// leaves (or erases) a neighbour's overhang the full repaint would have drawn.
  private func clipped(
    toRow row: Int, originY: CGFloat, metrics: TerminalRenderMetrics, context: CGContext, _ draw: () -> Void
  ) {
    context.saveGState()
    context.clip(to: CGRect(x: 0, y: CGFloat(row) * metrics.cellHeight + originY, width: metrics.size.width, height: metrics.cellHeight))
    draw()
    context.restoreGState()
  }

  // MARK: - Images

  private static let transparent: UInt32 = 0

  private static func clearingDefaultBackground(_ cell: GridSnapshot.Cell) -> GridSnapshot.Cell {
    guard cell.attrs & GridSnapshot.attrDefaultBackground != 0 else { return cell }
    var cleared = cell
    cleared.background = transparent
    return cleared
  }

  private func drawImages(
    _ layer: TerminalImageLayer, depth: TerminalImageLayer.Depth, originY: CGFloat,
    metrics: TerminalRenderMetrics, context: CGContext
  ) {
    for placement in layer.placements where placement.depth == depth {
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
            space: Self.colorSpace,
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
    metrics: TerminalRenderMetrics, context: CGContext, skipping skipped: UInt32? = nil
  ) {
    let rowStart = row * cols
    let y = CGFloat(row) * metrics.cellHeight + originY
    for span in TerminalRunBuilder.backgrounds(cells: cells, rowStart: rowStart, cols: cols) where span.color != skipped {
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
    row: Int, cols: Int, cells: [GridSnapshot.Cell], clusters: [Int: String], originY: CGFloat,
    metrics: TerminalRenderMetrics, glyphCache: TerminalGlyphCache, context: CGContext
  ) {
    let rowStart = row * cols
    let y = CGFloat(row) * metrics.cellHeight + originY
    let baseline = y + (metrics.cellHeight - metrics.font.lineHeight) / 2 + metrics.font.ascender
    for run in TerminalRunBuilder.glyphRuns(cells: cells, rowStart: rowStart, cols: cols) {
      let bold = run.style & GridSnapshot.attrBold != 0
      let italic = run.style & GridSnapshot.attrItalic != 0
      let textColor = run.style & GridSnapshot.attrDim != 0 ? dimColor(run.color) : color(run.color)
      context.setFillColor(textColor)

      // A run can mix fonts (Core Text fallback for uncovered codepoints), and glyph
      // ids only mean anything relative to their font, so flush on every font change.
      var batchFont: CTFont?
      glyphBuffer.removeAll(keepingCapacity: true)
      positionBuffer.removeAll(keepingCapacity: true)

      // CTFontDrawGlyphs positions are in TEXT space: a flipped text matrix draws at
      // -baseline, off the canvas. So flip the CTM around the baseline, glyphs at y = 0.
      func flush() {
        guard let batchFont, !glyphBuffer.isEmpty else { return }
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: 0, y: baseline)
        context.scaleBy(x: 1, y: -1)
        CTFontDrawGlyphs(batchFont, glyphBuffer, positionBuffer, glyphBuffer.count, context)
        context.restoreGState()
        glyphBuffer.removeAll(keepingCapacity: true)
        positionBuffer.removeAll(keepingCapacity: true)
        context.setFillColor(textColor)
      }

      for (offset, codepoint) in run.codepoints.enumerated() {
        let col = run.startCol + offset
        let index = rowStart + col
        let cell = cells[index]
        let span: CGFloat = cell.attrs & GridSnapshot.attrWide != 0 ? 2 : 1
        let box = CGRect(x: CGFloat(col) * metrics.cellWidth, y: y, width: metrics.cellWidth * span, height: metrics.cellHeight)
        if clusters[index] != nil || TerminalBoxDrawing.handles(codepoint) {
          flush()
          drawCell(cell, cluster: clusters[index], in: box, color: textColor, metrics: metrics, glyphCache: glyphCache, context: context)
          continue
        }
        guard let resolved = glyphCache.glyph(for: codepoint, bold: bold, italic: italic) else { continue }
        // The cache hands back the same font object for the same face, so identity will do.
        if let current = batchFont, current !== resolved.font { flush() }
        batchFont = resolved.font
        glyphBuffer.append(resolved.glyph)
        // A two-column glyph is centred in both its cells; one column uses the font's own inset.
        // y is 0 because `flush` has already translated to the baseline.
        let x = span > 1 ? box.minX + (box.width - resolved.advance) / 2 : box.minX + glyphOffsetX
        positionBuffer.append(CGPoint(x: x, y: 0))
      }
      flush()
    }
    drawDecorations(row: row, cols: cols, cells: cells, y: y, baseline: baseline, metrics: metrics, context: context)
  }

  /// One cell drawn on its own: a box-drawing shape, a multi-scalar grapheme set as a line, or
  /// a single glyph. Used where a glyph run can't carry it, and for the cursor cell.
  private func drawCell(
    _ cell: GridSnapshot.Cell, cluster: String?, in box: CGRect, color ink: CGColor,
    metrics: TerminalRenderMetrics, glyphCache: TerminalGlyphCache, context: CGContext
  ) {
    if cluster == nil, TerminalBoxDrawing.handles(cell.codepoint) {
      TerminalBoxDrawing.draw(cell.codepoint, in: box, color: ink, pixel: 1 / metrics.scale, context: context)
      return
    }
    let bold = cell.attrs & GridSnapshot.attrBold != 0
    let italic = cell.attrs & GridSnapshot.attrItalic != 0
    let baseline = box.minY + (box.height - metrics.font.lineHeight) / 2 + metrics.font.ascender
    let text = cluster ?? Unicode.Scalar(cell.codepoint).map { String($0) } ?? ""
    guard !text.isEmpty else { return }
    let font = glyphCache.font(bold: bold, italic: italic)
    let attributed = NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
    ])
    let line = CTLineCreateWithAttributedString(attributed)
    let width = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    context.saveGState()
    context.textMatrix = .identity
    context.translateBy(x: box.minX + max(0, (box.width - width) / 2), y: baseline)
    context.scaleBy(x: 1, y: -1)
    CTLineDraw(line, context)
    context.restoreGState()
  }

  /// Underlines and strikethroughs as spans over the cells that carry them, spaces included,
  /// at the font's own underline position and thickness.
  private func drawDecorations(
    row: Int, cols: Int, cells: [GridSnapshot.Cell], y: CGFloat, baseline: CGFloat,
    metrics: TerminalRenderMetrics, context: CGContext
  ) {
    let spans = TerminalRunBuilder.decorations(cells: cells, rowStart: row * cols, cols: cols)
    guard !spans.isEmpty, let glyphCache else { return }
    let font = glyphCache.regular
    let pixel = 1 / metrics.scale
    let thickness = max(pixel, (CTFontGetUnderlineThickness(font) / pixel).rounded() * pixel)
    let bottom = y + metrics.cellHeight
    // Below the baseline by the font's offset, but never under the row.
    let underlineY = min(baseline - CTFontGetUnderlinePosition(font), bottom - thickness)
    let strikeY = baseline - CTFontGetXHeight(font) / 2
    for span in spans {
      let x = CGFloat(span.startCol) * metrics.cellWidth
      let width = CGFloat(span.length) * metrics.cellWidth
      context.setFillColor(color(span.color))
      context.setStrokeColor(color(span.color))
      switch span.kind {
      case .strikethrough:
        context.fill(CGRect(x: x, y: strikeY - thickness / 2, width: width, height: thickness))
      case .underline(.single):
        context.fill(CGRect(x: x, y: underlineY, width: width, height: thickness))
      case .underline(.double):
        let second = underlineY + thickness * 2 + thickness <= bottom ? underlineY + thickness * 2 : underlineY - thickness * 2
        context.fill(CGRect(x: x, y: underlineY, width: width, height: thickness))
        context.fill(CGRect(x: x, y: second, width: width, height: thickness))
      case .underline(.curly):
        let amplitude = min(thickness * 1.5, max(pixel, bottom - underlineY - thickness))
        let wavelength = metrics.cellWidth
        let path = CGMutablePath()
        path.move(to: CGPoint(x: x, y: underlineY))
        var cursor = x
        while cursor < x + width {
          let mid = cursor + wavelength / 2
          let end = cursor + wavelength
          path.addQuadCurve(to: CGPoint(x: mid, y: underlineY), control: CGPoint(x: cursor + wavelength / 4, y: underlineY - amplitude))
          path.addQuadCurve(to: CGPoint(x: end, y: underlineY), control: CGPoint(x: mid + wavelength / 4, y: underlineY + amplitude))
          cursor = end
        }
        context.setLineWidth(thickness)
        context.addPath(path)
        context.strokePath()
      case .underline(.dotted):
        var cursor = x
        while cursor < x + width {
          context.fill(CGRect(x: cursor, y: underlineY, width: thickness, height: thickness))
          cursor += thickness * 2
        }
      case .underline(.dashed):
        var cursor = x
        let dash = max(thickness * 3, metrics.cellWidth / 2)
        while cursor < x + width {
          context.fill(CGRect(x: cursor, y: underlineY, width: min(dash, x + width - cursor), height: thickness))
          cursor += dash * 1.5
        }
      }
    }
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
        space: Self.colorSpace,
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
    dimColors.removeAll(keepingCapacity: true)
    paintedCells = []
    paintedOriginY = -1
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

  private func dimColor(_ argb: UInt32) -> CGColor {
    if let cached = dimColors[argb] { return cached }
    let base = color(argb)
    let dim = base.copy(alpha: base.alpha * 0.65) ?? base
    dimColors[argb] = dim
    return dim
  }

  private func color(_ argb: UInt32) -> CGColor {
    if let cached = colors[argb] { return cached }
    let a = CGFloat((argb >> 24) & 0xFF) / 255
    let r = CGFloat((argb >> 16) & 0xFF) / 255
    let g = CGFloat((argb >> 8) & 0xFF) / 255
    let b = CGFloat(argb & 0xFF) / 255
    let color = CGColor(colorSpace: Self.colorSpace, components: [r, g, b, a == 0 ? 1 : a])
      ?? UIColor(red: r, green: g, blue: b, alpha: a == 0 ? 1 : a).cgColor
    colors[argb] = color
    return color
  }
}
