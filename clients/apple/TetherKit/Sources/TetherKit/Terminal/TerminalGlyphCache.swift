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
///
/// The font travels with the glyph. `CTFontGetGlyphsForCharacters` does not
/// cascade, so a monospace face that has no CJK, emoji or box-drawing coverage
/// reports a miss — and a cache that returned only a glyph id would have made
/// the renderer drop those cells, which the `CTLine` path it replaced drew
/// through Core Text's own fallback. A miss is resolved once with
/// `CTFontCreateForString` and then cached like any hit.
final class TerminalGlyphCache {
  struct Resolved {
    var glyph: CGGlyph
    var font: CTFont
  }

  let regular: CTFont
  let bold: CTFont
  /// `nil` marks a codepoint no font on the system can draw, so the lookup is
  /// not retried every frame.
  private var glyphs: [UInt64: Resolved?] = [:]

  init(regular: UIFont, bold: UIFont) {
    // UIFont is toll-free bridged to CTFont; this is the documented way to
    // cross over without re-resolving the descriptor.
    self.regular = unsafeBitCast(regular, to: CTFont.self)
    self.bold = unsafeBitCast(bold, to: CTFont.self)
  }

  func font(bold: Bool) -> CTFont { bold ? self.bold : regular }

  /// `nil` when nothing on the system can draw this codepoint — the caller
  /// should skip the cell rather than draw a .notdef box.
  func glyph(for codepoint: UInt32, bold: Bool) -> Resolved? {
    let key = UInt64(codepoint) | (bold ? 1 << 32 : 0)
    if let cached = glyphs[key] { return cached }
    let resolved = lookup(codepoint: codepoint, bold: bold)
    glyphs[key] = resolved
    return resolved
  }

  private func lookup(codepoint: UInt32, bold: Bool) -> Resolved? {
    guard let scalar = Unicode.Scalar(codepoint) else { return nil }
    let text = String(scalar)
    var utf16 = Array(text.utf16)
    let base = font(bold: bold)
    if let glyph = glyph(for: &utf16, in: base) {
      return Resolved(glyph: glyph, font: base)
    }

    // Core Text picks the fallback face it would have used inside a CTLine.
    let fallback = CTFontCreateForString(base, text as CFString, CFRange(location: 0, length: utf16.count))
    guard let glyph = glyph(for: &utf16, in: fallback) else { return nil }
    return Resolved(glyph: glyph, font: fallback)
  }

  private func glyph(for utf16: inout [UInt16], in font: CTFont) -> CGGlyph? {
    var out = [CGGlyph](repeating: 0, count: utf16.count)
    // A surrogate pair maps to a single glyph reported in the first slot.
    let ok = CTFontGetGlyphsForCharacters(font, &utf16, &out, utf16.count)
    guard ok, let first = out.first, first != 0 else { return nil }
    return first
  }
}
#endif
