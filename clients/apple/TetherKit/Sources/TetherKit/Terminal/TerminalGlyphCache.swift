import CoreGraphics
import CoreText
import UIKit

/// Codepoint → `CGGlyph` + font. `CTFontGetGlyphsForCharacters` does not cascade, so a
/// miss is resolved once via `CTFontCreateForString` and cached with its fallback font.
final class TerminalGlyphCache {
  struct Resolved {
    var glyph: CGGlyph
    var font: CTFont
    /// The glyph's own advance, to centre a two-column glyph in its two cells.
    var advance: CGFloat
  }

  let regular: CTFont
  let bold: CTFont
  let italic: CTFont
  let boldItalic: CTFont
  /// `nil` marks a codepoint no font on the system can draw, so the lookup is
  /// not retried every frame.
  private var glyphs: [UInt64: Resolved?] = [:]
  private var fallbackFaces: [String: CTFont] = [:]

  init(regular: UIFont, bold: UIFont) {
    // UIFont is toll-free bridged to CTFont; this is the documented way to
    // cross over without re-resolving the descriptor.
    self.regular = unsafeBitCast(regular, to: CTFont.self)
    self.bold = unsafeBitCast(bold, to: CTFont.self)
    italic = Self.italic(of: self.regular)
    boldItalic = Self.italic(of: self.bold)
  }

  func font(bold: Bool, italic: Bool = false) -> CTFont {
    switch (bold, italic) {
    case (false, false): regular
    case (true, false): self.bold
    case (false, true): self.italic
    case (true, true): boldItalic
    }
  }

  /// `nil` when nothing on the system can draw this codepoint — the caller
  /// should skip the cell rather than draw a .notdef box.
  func glyph(for codepoint: UInt32, bold: Bool, italic: Bool = false) -> Resolved? {
    let key = UInt64(codepoint) | (bold ? 1 << 32 : 0) | (italic ? 1 << 33 : 0)
    if let cached = glyphs[key] { return cached }
    let resolved = lookup(codepoint: codepoint, base: font(bold: bold, italic: italic))
    glyphs[key] = resolved
    return resolved
  }

  private func lookup(codepoint: UInt32, base: CTFont) -> Resolved? {
    guard let scalar = Unicode.Scalar(codepoint) else { return nil }
    let text = String(scalar)
    var utf16 = Array(text.utf16)
    if let glyph = glyph(for: &utf16, in: base) {
      return Resolved(glyph: glyph, font: base, advance: advance(of: glyph, in: base))
    }

    // Core Text picks the fallback face it would have used inside a CTLine.
    let created = CTFontCreateForString(base, text as CFString, CFRange(location: 0, length: utf16.count))
    // One object per face, so the renderer can batch glyphs by font identity.
    let name = "\(CTFontCopyPostScriptName(created))|\(CTFontGetSymbolicTraits(base).rawValue)"
    let fallback = fallbackFaces[name] ?? created
    fallbackFaces[name] = fallback
    guard let glyph = glyph(for: &utf16, in: fallback) else { return nil }
    return Resolved(glyph: glyph, font: fallback, advance: advance(of: glyph, in: fallback))
  }

  private func glyph(for utf16: inout [UInt16], in font: CTFont) -> CGGlyph? {
    var out = [CGGlyph](repeating: 0, count: utf16.count)
    // A surrogate pair maps to a single glyph reported in the first slot.
    let ok = CTFontGetGlyphsForCharacters(font, &utf16, &out, utf16.count)
    guard ok, let first = out.first, first != 0 else { return nil }
    return first
  }

  private func advance(of glyph: CGGlyph, in font: CTFont) -> CGFloat {
    var glyphs = [glyph]
    var advances = [CGSize.zero]
    return CGFloat(CTFontGetAdvancesForGlyphs(font, .horizontal, &glyphs, &advances, 1))
  }

  /// The family's italic face when it has one; otherwise the upright face slanted, as most
  /// terminals do for a monospace family without an italic.
  private static func italic(of font: CTFont) -> CTFont {
    let traits = CTFontGetSymbolicTraits(font).union(.traitItalic)
    if let face = CTFontCreateCopyWithSymbolicTraits(font, 0, nil, traits, .traitItalic) {
      return face
    }
    var slant = CGAffineTransform(a: 1, b: 0, c: 0.2, d: 1, tx: 0, ty: 0)
    return CTFontCreateWithFontDescriptor(CTFontCopyFontDescriptor(font), CTFontGetSize(font), &slant)
  }
}
