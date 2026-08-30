#if canImport(UIKit)
import CoreGraphics
import CoreText
import UIKit

/// Codepoint → `CGGlyph`, so the render loop never builds an `NSAttributedString`.
///
/// Shaping one attributed string per cell was the single most expensive thing
/// the surface did: three allocations, a `CTLine`, and a bounds measurement for
/// every visible character on every frame. A terminal grid is monospaced and
/// unshaped by definition, so the mapping is a pure function of the codepoint
/// and can be memoized for the lifetime of the font.
final class TerminalGlyphCache {
  /// A codepoint with no glyph in this font. Cached as well as hits, so a run
  /// of unmappable characters does not re-ask CoreText every frame.
  private static let missing: CGGlyph = 0

  let regular: CTFont
  let bold: CTFont
  private var glyphs: [UInt64: CGGlyph] = [:]

  init(regular: UIFont, bold: UIFont) {
    // UIFont is toll-free bridged to CTFont; this is the documented way to
    // cross over without re-resolving the descriptor.
    self.regular = unsafeBitCast(regular, to: CTFont.self)
    self.bold = unsafeBitCast(bold, to: CTFont.self)
  }

  func font(bold: Bool) -> CTFont { bold ? self.bold : regular }

  /// `nil` when the font cannot draw this codepoint — the caller should skip
  /// the cell rather than draw a .notdef box.
  func glyph(for codepoint: UInt32, bold: Bool) -> CGGlyph? {
    let key = UInt64(codepoint) | (bold ? 1 << 32 : 0)
    if let cached = glyphs[key] {
      return cached == Self.missing ? nil : cached
    }
    let resolved = lookup(codepoint: codepoint, bold: bold)
    glyphs[key] = resolved
    return resolved == Self.missing ? nil : resolved
  }

  private func lookup(codepoint: UInt32, bold: Bool) -> CGGlyph {
    guard let scalar = Unicode.Scalar(codepoint) else { return Self.missing }
    var utf16 = Array(String(scalar).utf16)
    var out = [CGGlyph](repeating: 0, count: utf16.count)
    // A surrogate pair maps to a single glyph reported in the first slot.
    let ok = CTFontGetGlyphsForCharacters(font(bold: bold), &utf16, &out, utf16.count)
    guard ok, let first = out.first else { return Self.missing }
    return first
  }
}
#endif
