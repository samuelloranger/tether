import SwiftUI

import UIKit

/// The chrome palette of the chosen terminal theme. A view reading a token in `body` is
/// redrawn when the theme changes; see DESIGN.md for the Tether palettes.
public enum TetherColors {
  public static var background: Color { color(\.background) }
  public static var surface: Color { color(\.surface) }
  public static var surfaceHover: Color { color(\.surfaceHover) }
  public static var surfaceRaised: Color { color(\.raised) }
  public static var input: Color { color(\.input) }

  public static var textPrimary: Color { color(\.text) }
  public static var textSecondary: Color { color(\.textSecondary) }
  public static var textFaint: Color { color(\.textFaint) }
  public static var placeholder: Color { color(\.placeholder) }

  public static var border: Color { color(\.border) }

  public static var accent: Color { color(\.accent) }
  public static var onAccent: Color { color(\.onAccent) }

  public static var success: Color { color(\.success) }
  public static var warning: Color { color(\.warning) }
  public static var danger: Color { color(\.danger) }
  public static var onDanger: Color { color(\.onDanger) }

  public static var heatCool: Color { accent }

  /// Behind the terminal grid. Tether's is `#1E1E2E` in `#08080E` chrome; for any other
  /// theme it is the background itself.
  public static var well: Color { color(\.well) }

  private static func color(_ token: KeyPath<ChromePalette, UInt32>) -> Color {
    Color(uiColor: uiColor(rgb: ChromeTheme.shared.palette[keyPath: token]))
  }

  static func uiColor(rgb: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((rgb >> 16) & 0xFF) / 255,
      green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255,
      alpha: 1)
  }
}

/// The palette every `TetherColors` token reads. `AppPreferences` sets it from the terminal
/// theme; SwiftUI tracks the read, so changing it redraws every view that used a token.
@Observable
public final class ChromeTheme: @unchecked Sendable {
  nonisolated(unsafe) public static let shared = ChromeTheme()

  public private(set) var palette: ChromePalette = .tether
  public private(set) var isLight = false

  @MainActor public func apply(_ theme: TerminalTheme) {
    let next = theme.chrome
    guard next != palette || theme.isLight != isLight else { return }
    palette = next
    isLight = theme.isLight
    TetherMacWindow.applyBarAppearance()
  }
}

extension View {
  /// A system List or Form on the theme's background, not the system's grouped greys.
  /// Rows take `themedRow()`. Text keeps the system label colours, which follow the
  /// theme's light or dark; a list-wide foreground style would also repaint its buttons.
  func themedList() -> some View {
    scrollContentBackground(.hidden)
      .background(TetherColors.background)
  }

  func themedRow() -> some View {
    listRowBackground(TetherColors.surface)
  }
}

public extension Color {
  init(hex: String) {
    let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var value: UInt64 = 0
    Scanner(string: cleaned).scanHexInt64(&value)
    let r = Double((value >> 16) & 0xFF) / 255
    let g = Double((value >> 8) & 0xFF) / 255
    let b = Double(value & 0xFF) / 255
    self.init(red: r, green: g, blue: b)
  }
}
