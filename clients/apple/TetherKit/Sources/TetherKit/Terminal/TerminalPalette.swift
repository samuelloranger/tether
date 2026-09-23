import SwiftTerm

/// Theme and color resolution for `TerminalEngine`.
///
/// `background` must equal `TetherColors.terminalBackground` or a seam shows
/// around the grid.
enum TerminalPalette {
  static let foreground: UInt32 = 0xFFCC_CCCC
  static let background: UInt32 = 0xFF1E_1E2E
  static let ansi: [UInt32] = [
    0xFF1E_1E2E, 0xFFF3_8BA8, 0xFFA6_E3A1, 0xFFF9_E2AF,
    0xFF89_B4FA, 0xFFCB_A6F7, 0xFF94_E2D5, 0xFFCD_D6F4,
    0xFF58_5872, 0xFFF3_8BA8, 0xFFA6_E3A1, 0xFFF9_E2AF,
    0xFF89_B4FA, 0xFFCB_A6F7, 0xFF94_E2D5, 0xFFFF_FFFF,
  ]

  static var blankCell: GridSnapshot.Cell {
    GridSnapshot.Cell(codepoint: 0x20, foreground: foreground, background: background, attrs: 0)
  }

  static func install(on terminal: Terminal) {
    terminal.installPalette(colors: ansi.map(color))
    terminal.foregroundColor = color(foreground)
    terminal.backgroundColor = color(background)
  }

  static func resolve(_ value: Attribute.Color, isForeground: Bool, terminal: Terminal) -> UInt32 {
    switch value {
    case let .trueColor(red, green, blue):
      return pack(red, green, blue)
    case let .ansi256(code):
      // paletteColor, not our table: programs can repaint entries with OSC 4.
      guard let entry = terminal.paletteColor(index: Int(code)) else {
        return isForeground ? foreground : background
      }
      return pack(UInt8(entry.red >> 8), UInt8(entry.green >> 8), UInt8(entry.blue >> 8))
    case .defaultColor:
      return isForeground ? foreground : background
    case .defaultInvertedColor:
      return isForeground ? background : foreground
    }
  }

  private static func color(_ argb: UInt32) -> Color {
    Color(
      red8: UInt16((argb >> 16) & 0xFF),
      green8: UInt16((argb >> 8) & 0xFF),
      blue8: UInt16(argb & 0xFF))
  }

  private static func pack(_ red: UInt8, _ green: UInt8, _ blue: UInt8) -> UInt32 {
    0xFF00_0000 | UInt32(red) << 16 | UInt32(green) << 8 | UInt32(blue)
  }
}
