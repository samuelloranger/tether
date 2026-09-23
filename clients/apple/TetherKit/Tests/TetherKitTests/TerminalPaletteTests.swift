import SwiftTerm
import XCTest
@testable import TetherKit

final class TerminalPaletteTests: XCTestCase {
  private final class NullDelegate: TerminalDelegate {
    func send(source: Terminal, data: ArraySlice<UInt8>) {}
  }

  private func terminal() -> (Terminal, NullDelegate) {
    let delegate = NullDelegate()
    var options = TerminalOptions.default
    options.ansi256PaletteStrategy = .xterm
    let terminal = Terminal(delegate: delegate, options: options)
    TerminalPalette.install(on: terminal)
    return (terminal, delegate)
  }

  func test_truecolor_resolves_directly() {
    let (t, d) = terminal()
    XCTAssertEqual(
      TerminalPalette.resolve(.trueColor(red: 255, green: 0, blue: 0), isForeground: true, terminal: t),
      0xFFFF_0000)
    withExtendedLifetime(d) {}
  }

  func test_ansi_16_uses_the_installed_theme() {
    let (t, d) = terminal()
    XCTAssertEqual(TerminalPalette.resolve(.ansi256(code: 1), isForeground: true, terminal: t), 0xFFF3_8BA8)
    XCTAssertEqual(TerminalPalette.resolve(.ansi256(code: 15), isForeground: true, terminal: t), 0xFFFF_FFFF)
    withExtendedLifetime(d) {}
  }

  func test_ansi_256_uses_the_standard_xterm_cube() {
    let (t, d) = terminal()
    // 67 = cube (1,2,3) → xterm levels 95,135,175.
    XCTAssertEqual(TerminalPalette.resolve(.ansi256(code: 67), isForeground: true, terminal: t), 0xFF5F_87AF)
    // 244 = gray ramp step 12 → 8 + 12*10 = 128.
    XCTAssertEqual(TerminalPalette.resolve(.ansi256(code: 244), isForeground: true, terminal: t), 0xFF80_8080)
    withExtendedLifetime(d) {}
  }

  func test_default_colors_map_to_the_theme_pair_and_invert_swaps_it() {
    let (t, d) = terminal()
    XCTAssertEqual(TerminalPalette.resolve(.defaultColor, isForeground: true, terminal: t), TerminalPalette.foreground)
    XCTAssertEqual(TerminalPalette.resolve(.defaultColor, isForeground: false, terminal: t), TerminalPalette.background)
    XCTAssertEqual(TerminalPalette.resolve(.defaultInvertedColor, isForeground: true, terminal: t), TerminalPalette.background)
    XCTAssertEqual(TerminalPalette.resolve(.defaultInvertedColor, isForeground: false, terminal: t), TerminalPalette.foreground)
    withExtendedLifetime(d) {}
  }

  func test_background_matches_the_app_chrome() {
    XCTAssertEqual(TerminalPalette.background, 0xFF1E_1E2E)
    XCTAssertEqual(TerminalPalette.foreground, 0xFFCC_CCCC)
  }
}
