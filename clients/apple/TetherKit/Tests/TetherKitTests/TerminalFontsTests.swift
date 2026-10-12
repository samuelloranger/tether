import CoreText
import UIKit
import XCTest
@testable import TetherKit

final class TerminalFontsTests: XCTestCase {
  override func setUp() {
    TerminalFonts.registerBundledFonts()
  }

  private func postScriptName(_ font: CTFont) -> String {
    CTFontCopyPostScriptName(font) as String
  }

  func test_every_bundled_face_registers_under_its_postscript_name() {
    for font in TerminalFont.builtIn where font.source == .bundled {
      XCTAssertNotNil(UIFont(name: font.postScriptName, size: 12), font.label)
    }
    XCTAssertNotNil(UIFont(name: TerminalFonts.symbolsPostScriptName, size: 12))
  }

  func test_bold_picks_the_bundled_bold_face() {
    let bold = TerminalFonts.font(postScriptName: "JetBrainsMono-Regular", size: 12, bold: true)
    XCTAssertEqual(bold.fontName, "JetBrainsMono-Bold")
    let comic = TerminalFonts.font(postScriptName: "ComicMono", size: 12, bold: true)
    XCTAssertEqual(comic.fontName, "ComicMono-Bold")
  }

  func test_an_unknown_face_falls_back_to_the_system_monospace() {
    let font = TerminalFonts.font(postScriptName: "NoSuchFont-Regular", size: 12, bold: false)
    XCTAssertTrue(font.fontDescriptor.symbolicTraits.contains(.traitMonoSpace))
  }

  func test_nerd_font_icons_fall_back_to_the_bundled_symbols() {
    for name in ["Menlo-Regular", "JetBrainsMono-Regular"] {
      let regular = TerminalFonts.font(postScriptName: name, size: 12, bold: false)
      let cache = TerminalGlyphCache(
        regular: regular, bold: TerminalFonts.font(postScriptName: name, size: 12, bold: true)
      )
      // Some faces (JetBrains Mono) draw powerline themselves; any face will do for it.
      XCTAssertNotNil(cache.glyph(for: 0xE0A0, bold: false))
      // U+F09B Font Awesome GitHub, U+F0219 Material Design: only the symbols font has them.
      for codepoint: UInt32 in [0xF09B, 0xF0219] {
        let resolved = cache.glyph(for: codepoint, bold: false)
        XCTAssertNotNil(resolved, "\(name) U+\(String(codepoint, radix: 16))")
        XCTAssertEqual(resolved.map { postScriptName($0.font) }, TerminalFonts.symbolsPostScriptName)
      }
      XCTAssertEqual(cache.glyph(for: 0x41, bold: false).map { postScriptName($0.font) }, name)
    }
  }

  func test_the_symbols_cascade_keeps_the_system_fallback_for_cjk_and_emoji() {
    for name in ["Menlo-Regular", "JetBrainsMono-Regular", "ComicMono"] {
      let cache = TerminalGlyphCache(
        regular: TerminalFonts.font(postScriptName: name, size: 12, bold: false),
        bold: TerminalFonts.font(postScriptName: name, size: 12, bold: true)
      )
      // 你 あ 한 😀: none are in the terminal faces or the symbols font.
      for codepoint: UInt32 in [0x4F60, 0x3042, 0xD55C, 0x1F600] {
        let face = cache.glyph(for: codepoint, bold: false).map { postScriptName($0.font) }
        XCTAssertNotNil(face, "\(name) U+\(String(codepoint, radix: 16)) has no glyph")
        XCTAssertNotEqual(face, TerminalFonts.symbolsPostScriptName)
        XCTAssertNotEqual(face, name)
      }
    }
  }

  /// Faces without these symbols (Comic Mono, Fira Code, JetBrains Mono for ✔) must still
  /// draw their text form. Core Text falls back to Apple Color Emoji, which only has the
  /// emoji form: a colour picture two cells wide, or its missing-glyph box.
  func test_check_and_cross_marks_draw_from_a_real_face_in_every_terminal_font() {
    for name in TerminalFont.builtIn.map(\.postScriptName) {
      let cache = TerminalGlyphCache(
        regular: TerminalFonts.font(postScriptName: name, size: 14, bold: false),
        bold: TerminalFonts.font(postScriptName: name, size: 14, bold: true)
      )
      // ✓ ✔ ✗ ✘ ✖ ➜ ⏺ (Claude Code's bullet)
      for codepoint: UInt32 in [0x2713, 0x2714, 0x2717, 0x2718, 0x2716, 0x279C, 0x23FA] {
        for bold in [false, true] {
          let label = "\(name)\(bold ? " bold" : "") U+\(String(codepoint, radix: 16, uppercase: true))"
          guard let resolved = cache.glyph(for: codepoint, bold: bold) else {
            XCTFail("\(label): no glyph at all"); continue
          }
          let face = postScriptName(resolved.font)
          let glyphName = CTFontCopyNameForGlyph(resolved.font, resolved.glyph).map { $0 as String } ?? "?"
          XCTAssertFalse(face.hasPrefix("LastResort") || face.contains("AppleColorEmoji"), "\(label) falls back to \(face)")
          XCTAssertFalse(
            glyphName == ".notdef" || glyphName.lowercased().hasPrefix("lastresort"),
            "\(label) draws the missing-glyph box \(glyphName) from \(face)"
          )
        }
      }
    }
  }

  func test_saved_ids_from_the_old_enum_still_resolve_and_unknown_ones_fall_back() {
    XCTAssertEqual(TerminalFont.named("SF Mono").postScriptName, "SFMono-Regular")
    XCTAssertEqual(TerminalFont.named("Courier New").postScriptName, "CourierNewPSMT")
    XCTAssertEqual(TerminalFont.named("gone"), .menlo)
  }
}
