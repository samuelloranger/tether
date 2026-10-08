import Foundation
import SwiftUI
import UIKit

/// A terminal color scheme: default colors plus the 16 ANSI entries. Colors are ARGB.
public struct TerminalTheme: Equatable, Identifiable, Sendable {
  public var id: String
  public var name: String
  public var background: UInt32
  public var foreground: UInt32
  public var cursor: UInt32
  public var selection: UInt32?
  public var ansi: [UInt32]

  public init(
    id: String, name: String, background: UInt32, foreground: UInt32,
    cursor: UInt32, selection: UInt32? = nil, ansi: [UInt32]
  ) {
    self.id = id
    self.name = name
    self.background = background
    self.foreground = foreground
    self.cursor = cursor
    self.selection = selection
    self.ansi = ansi
  }

  /// The palette Tether has always shipped with.
  public static let tether = TerminalTheme(
    id: "tether", name: "Tether",
    background: 0xFF1E_1E2E, foreground: 0xFFCC_CCCC, cursor: 0xFFFF_FFFF,
    ansi: [
      0xFF1E_1E2E, 0xFFF3_8BA8, 0xFFA6_E3A1, 0xFFF9_E2AF,
      0xFF89_B4FA, 0xFFCB_A6F7, 0xFF94_E2D5, 0xFFCD_D6F4,
      0xFF58_5872, 0xFFF3_8BA8, 0xFFA6_E3A1, 0xFFF9_E2AF,
      0xFF89_B4FA, 0xFFCB_A6F7, 0xFF94_E2D5, 0xFFFF_FFFF,
    ]
  )

  /// Aurora light's terminal: Catppuccin Latte with Aurora light's accent and state colours.
  public static let tetherLight = TerminalTheme(
    id: "tether-light", name: "Tether Light",
    background: 0xFFFB_FBFD, foreground: 0xFF14_141B, cursor: 0xFF14_141B,
    ansi: [
      0xFF5C_5F77, 0xFFC4_381C, 0xFF1C_7A4F, 0xFF8A_5A00,
      0xFF43_53D0, 0xFFEA_76CB, 0xFF17_9299, 0xFFAC_B0BE,
      0xFF6C_6F85, 0xFFD2_0F39, 0xFF40_A02B, 0xFFDF_8E1D,
      0xFF1E_66F5, 0xFFEA_76CB, 0xFF17_9299, 0xFFBC_C0CC,
    ]
  )

  /// Tether's own themes first, then the bundled schemes in their curated order.
  public static let catalog: [TerminalTheme] = [.tether, .tetherLight] + bundled()

  public static func named(_ id: String) -> TerminalTheme {
    catalog.first { $0.id == id } ?? .tether
  }

  /// Relative luminance above the midpoint: dark text on a light background.
  public var isLight: Bool {
    let r = Double((background >> 16) & 0xFF) / 255
    let g = Double((background >> 8) & 0xFF) / 255
    let b = Double(background & 0xFF) / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5
  }

  public var backgroundColor: Color { Color(uiColor: Self.uiColor(background)) }
  public var uiBackground: UIColor { Self.uiColor(background) }

  static func uiColor(_ argb: UInt32, alpha: CGFloat = 1) -> UIColor {
    UIColor(
      red: CGFloat((argb >> 16) & 0xFF) / 255,
      green: CGFloat((argb >> 8) & 0xFF) / 255,
      blue: CGFloat(argb & 0xFF) / 255,
      alpha: alpha
    )
  }

  static func bundled(from data: Data? = Bundle.module.url(forResource: "TerminalThemes", withExtension: "json")
    .flatMap { try? Data(contentsOf: $0) }) -> [TerminalTheme] {
    guard let data, let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
    return entries.compactMap(\.theme)
  }

  /// The generated JSON: hex RGB strings (`scripts/generate-terminal-themes.sh`).
  private struct Entry: Decodable {
    let id: String
    let name: String
    let background: String
    let foreground: String
    let cursor: String
    let selection: String?
    let ansi: [String]

    var theme: TerminalTheme? {
      guard let background = Self.argb(background), let foreground = Self.argb(foreground) else { return nil }
      let ansi = self.ansi.compactMap(Self.argb)
      guard ansi.count == 16 else { return nil }
      return TerminalTheme(
        id: id, name: name, background: background, foreground: foreground,
        cursor: Self.argb(cursor) ?? foreground, selection: selection.flatMap(Self.argb), ansi: ansi
      )
    }

    static func argb(_ hex: String) -> UInt32? {
      guard hex.count == 6, let rgb = UInt32(hex, radix: 16) else { return nil }
      return 0xFF00_0000 | rgb
    }
  }
}
