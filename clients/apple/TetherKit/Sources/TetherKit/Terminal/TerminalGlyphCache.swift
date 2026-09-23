import CoreGraphics
import CoreText
import UIKit

/// Codepoint → `CGGlyph` + font. `CTFontGetGlyphsForCharacters` does not cascade, so a
/// miss is resolved once via `CTFontCreateForString` and cached with its fallback font.
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
