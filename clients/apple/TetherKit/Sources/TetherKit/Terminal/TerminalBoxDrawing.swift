import CoreGraphics

/// Box drawing (U+2500–257F), block elements (U+2580–259F) and the powerline separators
/// (U+E0B0–E0B7) drawn as shapes filling the cell exactly. From the font they leave gaps
/// between cells and stripes between rows, since no font's glyph matches the cell box.
enum TerminalBoxDrawing {
  static func handles(_ codepoint: UInt32) -> Bool {
    (0x2500...0x259F).contains(codepoint) || (0xE0B0...0xE0B7).contains(codepoint)
  }

  /// Draws into `cell` (top-left origin, points) in `color`. `pixel` is one device pixel.
  static func draw(_ codepoint: UInt32, in cell: CGRect, color: CGColor, pixel: CGFloat, context: CGContext) {
    context.saveGState()
    defer { context.restoreGState() }
    context.setFillColor(color)
    context.setStrokeColor(color)
    switch codepoint {
    case 0x2580...0x259F: block(codepoint, in: cell, color: color, pixel: pixel, context: context)
    case 0xE0B0...0xE0B7: powerline(codepoint, in: cell, pixel: pixel, context: context)
    case 0x2504...0x250B, 0x254C...0x254F: dashed(codepoint, in: cell, pixel: pixel, context: context)
    case 0x256D...0x2570: arc(codepoint, in: cell, pixel: pixel, context: context)
    case 0x2571...0x2573: diagonal(codepoint, in: cell, pixel: pixel, context: context)
    default:
      if let arms = arms[codepoint] { lines(arms, in: cell, pixel: pixel, context: context) }
    }
  }

  // MARK: Lines

  /// Weight per arm: 0 none, 1 light, 2 heavy, 3 double.
  struct Arms: Equatable {
    var up: UInt8 = 0
    var right: UInt8 = 0
    var down: UInt8 = 0
    var left: UInt8 = 0
  }

  /// An even number of device pixels, so a light line and a heavy one (twice as wide) both
  /// centre on the same pixel boundary and neither edge lands on half a pixel.
  static func lightWidth(_ cell: CGRect, pixel: CGFloat) -> CGFloat {
    max(pixel * 2, (cell.width / 8 / (pixel * 2)).rounded() * pixel * 2)
  }

  private static func lines(_ arms: Arms, in cell: CGRect, pixel: CGFloat, context: CGContext) {
    let light = lightWidth(cell, pixel: pixel)
    let widths: [UInt8: CGFloat] = [1: light, 2: light * 2, 3: light]
    // Centre on a pixel boundary: with even widths, every edge then lands on a whole pixel.
    let cx = snap(cell.midX, pixel)
    let cy = snap(cell.midY, pixel)
    let gap = light
    func half(_ weight: UInt8) -> CGFloat {
      switch weight {
      case 0: return 0
      case 3: return gap + light / 2
      default: return (widths[weight] ?? light) / 2
      }
    }
    let vertical = max(half(arms.up), half(arms.down))
    let horizontal = max(half(arms.left), half(arms.right))

    /// Where a single or heavy arm starts. Against a double line across it, a tee's stem meets the
    /// near line (╤), a corner's reaches the far one (╒), and a crossing runs through both (╪).
    func singleStart(
      center: CGFloat, sign: CGFloat, across: (UInt8, UInt8), opposite: UInt8, extent: CGFloat
    ) -> CGFloat {
      guard across.0 == 3 || across.1 == 3 else { return center - sign * extent }
      let tee = across.0 != 0 && across.1 != 0 && opposite == 0
      return tee ? center + sign * (gap - light / 2) : center - sign * (gap + light / 2)
    }

    func horizontalArm(_ weight: UInt8, towardRight: Bool) {
      guard weight != 0 else { return }
      let end = towardRight ? cell.maxX : cell.minX
      let sign: CGFloat = towardRight ? 1 : -1
      if weight == 3 {
        // Each of the two lines stops at the stem on its own side, so corners and tees close.
        for (offset, perpendicular, other) in [(-gap, arms.up, arms.down), (gap, arms.down, arms.up)] {
          let start: CGFloat
          if perpendicular != 0 { start = cx + sign * (perpendicular == 3 ? gap - light / 2 : half(perpendicular)) }
          else if other != 0 { start = cx - sign * (other == 3 ? gap + light / 2 : half(other)) }
          else { start = cx }
          fill(x0: start, x1: end, y: cy + offset, thickness: light, horizontal: true, context: context)
        }
      } else {
        let start = singleStart(
          center: cx, sign: sign, across: (arms.up, arms.down), opposite: towardRight ? arms.left : arms.right,
          extent: vertical)
        fill(x0: start, x1: end, y: cy, thickness: widths[weight] ?? light, horizontal: true, context: context)
      }
    }

    func verticalArm(_ weight: UInt8, towardDown: Bool) {
      guard weight != 0 else { return }
      let end = towardDown ? cell.maxY : cell.minY
      let sign: CGFloat = towardDown ? 1 : -1
      if weight == 3 {
        for (offset, perpendicular, other) in [(-gap, arms.left, arms.right), (gap, arms.right, arms.left)] {
          let start: CGFloat
          if perpendicular != 0 { start = cy + sign * (perpendicular == 3 ? gap - light / 2 : half(perpendicular)) }
          else if other != 0 { start = cy - sign * (other == 3 ? gap + light / 2 : half(other)) }
          else { start = cy }
          fill(x0: start, x1: end, y: cx + offset, thickness: light, horizontal: false, context: context)
        }
      } else {
        let start = singleStart(
          center: cy, sign: sign, across: (arms.left, arms.right), opposite: towardDown ? arms.up : arms.down,
          extent: horizontal)
        fill(x0: start, x1: end, y: cx, thickness: widths[weight] ?? light, horizontal: false, context: context)
      }
    }

    horizontalArm(arms.right, towardRight: true)
    horizontalArm(arms.left, towardRight: false)
    verticalArm(arms.down, towardDown: true)
    verticalArm(arms.up, towardDown: false)
  }

  /// A bar from `x0` to `x1` along its axis, centred on `y` across it.
  private static func fill(
    x0: CGFloat, x1: CGFloat, y: CGFloat, thickness: CGFloat, horizontal: Bool, context: CGContext
  ) {
    let lo = min(x0, x1)
    let length = abs(x1 - x0)
    let rect = horizontal
      ? CGRect(x: lo, y: y - thickness / 2, width: length, height: thickness)
      : CGRect(x: y - thickness / 2, y: lo, width: thickness, height: length)
    context.fill(rect)
  }

  private static func snap(_ value: CGFloat, _ pixel: CGFloat) -> CGFloat {
    (value / pixel).rounded() * pixel
  }

  private static func dashed(_ codepoint: UInt32, in cell: CGRect, pixel: CGFloat, context: CGContext) {
    let index = codepoint >= 0x254C ? codepoint - 0x254C : codepoint - 0x2504
    let horizontal = index % 4 < 2
    let heavy = index % 2 == 1
    let segments: CGFloat = codepoint >= 0x254C ? 2 : (index < 4 ? 3 : 4)
    let light = lightWidth(cell, pixel: pixel)
    let thickness = heavy ? light * 2 : light
    let length = horizontal ? cell.width : cell.height
    let step = length / segments
    let dash = step * 0.6
    for segment in 0..<Int(segments) {
      let start = (horizontal ? cell.minX : cell.minY) + CGFloat(segment) * step + (step - dash) / 2
      fill(
        x0: start, x1: start + dash, y: horizontal ? cell.midY : cell.midX, thickness: thickness,
        horizontal: horizontal, context: context)
    }
  }

  private static func arc(_ codepoint: UInt32, in cell: CGRect, pixel: CGFloat, context: CGContext) {
    let light = lightWidth(cell, pixel: pixel)
    let cx = snap(cell.midX, pixel)
    let cy = snap(cell.midY, pixel)
    let radius = min(cell.width, cell.height) / 2
    let path = CGMutablePath()
    // ╭ down+right, ╮ down+left, ╯ up+left, ╰ up+right.
    let vertical = codepoint == 0x256D || codepoint == 0x256E ? cell.maxY : cell.minY
    let horizontal = codepoint == 0x256D || codepoint == 0x2570 ? cell.maxX : cell.minX
    path.move(to: CGPoint(x: cx, y: vertical))
    path.addArc(tangent1End: CGPoint(x: cx, y: cy), tangent2End: CGPoint(x: horizontal, y: cy), radius: radius)
    path.addLine(to: CGPoint(x: horizontal, y: cy))
    context.setLineWidth(light)
    context.addPath(path)
    context.strokePath()
  }

  private static func diagonal(_ codepoint: UInt32, in cell: CGRect, pixel: CGFloat, context: CGContext) {
    context.setLineWidth(lightWidth(cell, pixel: pixel))
    if codepoint != 0x2572 {
      context.move(to: CGPoint(x: cell.minX, y: cell.maxY))
      context.addLine(to: CGPoint(x: cell.maxX, y: cell.minY))
    }
    if codepoint != 0x2571 {
      context.move(to: CGPoint(x: cell.minX, y: cell.minY))
      context.addLine(to: CGPoint(x: cell.maxX, y: cell.maxY))
    }
    context.strokePath()
  }

  // MARK: Blocks

  private static func block(_ codepoint: UInt32, in cell: CGRect, color: CGColor, pixel: CGFloat, context: CGContext) {
    let w = cell.width
    let h = cell.height
    // Split points on whole pixels: a half-block boundary blended over one pixel row stripes
    // block-character images.
    func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) {
      let x0 = snap(cell.minX + x * w, pixel)
      let y0 = snap(cell.minY + y * h, pixel)
      let x1 = snap(cell.minX + (x + width) * w, pixel)
      let y1 = snap(cell.minY + (y + height) * h, pixel)
      context.fill(CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0))
    }
    switch codepoint {
    case 0x2580: rect(0, 0, 1, 0.5)
    case 0x2581...0x2588:
      let eighths = CGFloat(codepoint - 0x2580) / 8
      rect(0, 1 - eighths, 1, eighths)
    case 0x2589...0x258F:
      rect(0, 0, CGFloat(0x2590 - codepoint) / 8, 1)
    case 0x2590: rect(0.5, 0, 0.5, 1)
    case 0x2591...0x2593:
      context.setFillColor(color.copy(alpha: color.alpha * CGFloat(codepoint - 0x2590) / 4) ?? color)
      rect(0, 0, 1, 1)
    case 0x2594: rect(0, 0, 1, 0.125)
    case 0x2595: rect(0.875, 0, 0.125, 1)
    default:
      // Quadrants U+2596–259F: upper-left, upper-right, lower-left, lower-right.
      guard let quadrants = Self.quadrants[codepoint] else { return }
      if quadrants & 0b1000 != 0 { rect(0, 0, 0.5, 0.5) }
      if quadrants & 0b0100 != 0 { rect(0.5, 0, 0.5, 0.5) }
      if quadrants & 0b0010 != 0 { rect(0, 0.5, 0.5, 0.5) }
      if quadrants & 0b0001 != 0 { rect(0.5, 0.5, 0.5, 0.5) }
    }
  }

  private static let quadrants: [UInt32: UInt8] = [
    0x2596: 0b0010, 0x2597: 0b0001, 0x2598: 0b1000, 0x2599: 0b1011, 0x259A: 0b1001,
    0x259B: 0b1110, 0x259C: 0b1101, 0x259D: 0b0100, 0x259E: 0b0110, 0x259F: 0b0111,
  ]

  // MARK: Powerline

  private static func powerline(_ codepoint: UInt32, in cell: CGRect, pixel: CGFloat, context: CGContext) {
    let path = CGMutablePath()
    let pointsRight = codepoint == 0xE0B0 || codepoint == 0xE0B1 || codepoint == 0xE0B4 || codepoint == 0xE0B5
    let base = pointsRight ? cell.minX : cell.maxX
    let tip = pointsRight ? cell.maxX : cell.minX
    let solid = codepoint % 2 == 0
    switch codepoint {
    case 0xE0B0...0xE0B3:
      path.move(to: CGPoint(x: base, y: cell.minY))
      path.addLine(to: CGPoint(x: tip, y: cell.midY))
      path.addLine(to: CGPoint(x: base, y: cell.maxY))
    default:
      // A half ellipse the cell's full width and height, so the cap meets the segment beside it
      // at any line spacing.
      let halfHeight = cell.height / 2
      let stretch = CGAffineTransform(translationX: base, y: cell.midY).scaledBy(x: cell.width / halfHeight, y: 1)
      path.addArc(
        center: .zero, radius: halfHeight, startAngle: -.pi / 2, endAngle: .pi / 2,
        clockwise: !pointsRight, transform: stretch)
    }
    if solid {
      path.closeSubpath()
      context.addPath(path)
      context.fillPath()
    } else {
      context.setLineWidth(lightWidth(cell, pixel: pixel))
      context.addPath(path)
      context.strokePath()
    }
  }

  // MARK: Table

  private static let arms: [UInt32: Arms] = {
    // up, right, down, left per codepoint, U+2500–257F (dashes, arcs and diagonals drawn apart).
    let table: [(UInt32, UInt8, UInt8, UInt8, UInt8)] = [
      (0x2500, 0, 1, 0, 1), (0x2501, 0, 2, 0, 2), (0x2502, 1, 0, 1, 0), (0x2503, 2, 0, 2, 0),
      (0x250C, 0, 1, 1, 0), (0x250D, 0, 2, 1, 0), (0x250E, 0, 1, 2, 0), (0x250F, 0, 2, 2, 0),
      (0x2510, 0, 0, 1, 1), (0x2511, 0, 0, 1, 2), (0x2512, 0, 0, 2, 1), (0x2513, 0, 0, 2, 2),
      (0x2514, 1, 1, 0, 0), (0x2515, 1, 2, 0, 0), (0x2516, 2, 1, 0, 0), (0x2517, 2, 2, 0, 0),
      (0x2518, 1, 0, 0, 1), (0x2519, 1, 0, 0, 2), (0x251A, 2, 0, 0, 1), (0x251B, 2, 0, 0, 2),
      (0x251C, 1, 1, 1, 0), (0x251D, 1, 2, 1, 0), (0x251E, 2, 1, 1, 0), (0x251F, 1, 1, 2, 0),
      (0x2520, 2, 1, 2, 0), (0x2521, 2, 2, 1, 0), (0x2522, 1, 2, 2, 0), (0x2523, 2, 2, 2, 0),
      (0x2524, 1, 0, 1, 1), (0x2525, 1, 0, 1, 2), (0x2526, 2, 0, 1, 1), (0x2527, 1, 0, 2, 1),
      (0x2528, 2, 0, 2, 1), (0x2529, 2, 0, 1, 2), (0x252A, 1, 0, 2, 2), (0x252B, 2, 0, 2, 2),
      (0x252C, 0, 1, 1, 1), (0x252D, 0, 1, 1, 2), (0x252E, 0, 2, 1, 1), (0x252F, 0, 2, 1, 2),
      (0x2530, 0, 1, 2, 1), (0x2531, 0, 1, 2, 2), (0x2532, 0, 2, 2, 1), (0x2533, 0, 2, 2, 2),
      (0x2534, 1, 1, 0, 1), (0x2535, 1, 1, 0, 2), (0x2536, 1, 2, 0, 1), (0x2537, 1, 2, 0, 2),
      (0x2538, 2, 1, 0, 1), (0x2539, 2, 1, 0, 2), (0x253A, 2, 2, 0, 1), (0x253B, 2, 2, 0, 2),
      (0x253C, 1, 1, 1, 1), (0x253D, 1, 1, 1, 2), (0x253E, 1, 2, 1, 1), (0x253F, 1, 2, 1, 2),
      (0x2540, 2, 1, 1, 1), (0x2541, 1, 1, 2, 1), (0x2542, 2, 1, 2, 1), (0x2543, 2, 1, 1, 2),
      (0x2544, 2, 2, 1, 1), (0x2545, 1, 1, 2, 2), (0x2546, 1, 2, 2, 1), (0x2547, 2, 2, 1, 2),
      (0x2548, 1, 2, 2, 2), (0x2549, 2, 1, 2, 2), (0x254A, 2, 2, 2, 1), (0x254B, 2, 2, 2, 2),
      (0x2550, 0, 3, 0, 3), (0x2551, 3, 0, 3, 0),
      (0x2552, 0, 3, 1, 0), (0x2553, 0, 1, 3, 0), (0x2554, 0, 3, 3, 0),
      (0x2555, 0, 0, 1, 3), (0x2556, 0, 0, 3, 1), (0x2557, 0, 0, 3, 3),
      (0x2558, 1, 3, 0, 0), (0x2559, 3, 1, 0, 0), (0x255A, 3, 3, 0, 0),
      (0x255B, 1, 0, 0, 3), (0x255C, 3, 0, 0, 1), (0x255D, 3, 0, 0, 3),
      (0x255E, 1, 3, 1, 0), (0x255F, 3, 1, 3, 0), (0x2560, 3, 3, 3, 0),
      (0x2561, 1, 0, 1, 3), (0x2562, 3, 0, 3, 1), (0x2563, 3, 0, 3, 3),
      (0x2564, 0, 3, 1, 3), (0x2565, 0, 1, 3, 1), (0x2566, 0, 3, 3, 3),
      (0x2567, 1, 3, 0, 3), (0x2568, 3, 1, 0, 1), (0x2569, 3, 3, 0, 3),
      (0x256A, 1, 3, 1, 3), (0x256B, 3, 1, 3, 1), (0x256C, 3, 3, 3, 3),
      (0x2574, 0, 0, 0, 1), (0x2575, 1, 0, 0, 0), (0x2576, 0, 1, 0, 0), (0x2577, 0, 0, 1, 0),
      (0x2578, 0, 0, 0, 2), (0x2579, 2, 0, 0, 0), (0x257A, 0, 2, 0, 0), (0x257B, 0, 0, 2, 0),
      (0x257C, 0, 2, 0, 1), (0x257D, 1, 0, 2, 0), (0x257E, 0, 1, 0, 2), (0x257F, 2, 0, 1, 0),
    ]
    var arms: [UInt32: Arms] = [:]
    for (codepoint, up, right, down, left) in table {
      arms[codepoint] = Arms(up: up, right: right, down: down, left: left)
    }
    return arms
  }()
}
