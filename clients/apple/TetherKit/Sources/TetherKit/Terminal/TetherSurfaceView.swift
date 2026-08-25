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

  private var lastGeneration: UInt64?
  private var header: GridSnapshot.Header?
  private var cells: [GridSnapshot.Cell] = []

  private var cellWidth: CGFloat = 8
  private var cellHeight: CGFloat = 16
  private var font: UIFont = .monospacedSystemFont(ofSize: 14, weight: .regular)
  private var boldFont: UIFont = .monospacedSystemFont(ofSize: 14, weight: .bold)

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
    invalidateMetrics()
  }

  /// Updates the grid from packed TGRD bytes. Skips decode and redraw when generation is unchanged.
  public func updateSnapshot(_ bytes: Data) {
    guard let decoded = try? GridSnapshotDecoder.decode(bytes) else { return }
    if lastGeneration == decoded.0.generation { return }
    lastGeneration = decoded.0.generation
    header = decoded.0
    cells = decoded.1
    setNeedsDisplay()
  }

  public func clearSnapshot() {
    lastGeneration = nil
    header = nil
    cells = []
    setNeedsDisplay()
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
        // CoreText draws with y increasing UPWARD, while this view lays cells
        // out in UIKit coordinates with y increasing downward. Without a
        // flipped text matrix every glyph renders upside down — the cell
        // rectangles look right because CGContext.fill uses UIKit coordinates,
        // which is why only the text appeared mirrored.
        //
        // With the flip in place, textPosition is the BASELINE measured down
        // from the top of the cell, so it is derived from the ascender rather
        // than the descender.
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
