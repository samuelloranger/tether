import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// Chrome colours, resolved per appearance.
///
/// These were a single hardcoded dark palette, so `preferredColorScheme(.light)`
/// changed the scheme and nothing else — light mode rendered identically to dark.
/// Each colour is now dynamic, which fixes every existing call site without
/// touching any of them.
///
/// Light values are Catppuccin Latte, matching the flavours the desktop client
/// ships, so the two stay recognisably the same product.
public enum TetherColors {
  public static let background = dynamic(dark: 0x11_11_1B, light: 0xDC_E0_E8)
  public static let surface = dynamic(dark: 0x1E_1E_2E, light: 0xEF_F1_F5)
  public static let accent = dynamic(dark: 0x87_B5_FA, light: 0x1E_66_F5)
  public static let textPrimary = dynamic(dark: 0xCD_D6_F4, light: 0x4C_4F_69)
  public static let textSecondary = dynamic(dark: 0xA6_AD_C8, light: 0x6C_6F_85)
  public static let danger = dynamic(dark: 0xF3_8B_A8, light: 0xD2_0F_39)
  public static let success = dynamic(dark: 0xA6_E3_A1, light: 0x40_A0_2B)

  /// Foreground for text sitting ON the accent fill. Accent is a pale blue in
  /// dark mode and a deep blue in light mode, so a fixed black label was
  /// unreadable in one of the two.
  public static let onAccent = dynamic(dark: 0x11_11_1B, light: 0xFF_FF_FF)

  /// Deliberately NOT dynamic. This is the backing behind the terminal grid and
  /// has to stay in step with `TetherSurfaceView.backgroundColor`; the emulator
  /// renders its own palette, so a light backing would show as a bright seam
  /// around a dark grid.
  public static let terminalBackground = Color(hex: "1E1E2E")

  private static func dynamic(dark: UInt32, light: UInt32) -> Color {
    #if canImport(UIKit)
    return Color(
      UIColor { traits in
        traits.userInterfaceStyle == .light ? uiColor(light) : uiColor(dark)
      })
    #else
    return Color(rgb: dark)
    #endif
  }

  #if canImport(UIKit)
  private static func uiColor(_ rgb: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((rgb >> 16) & 0xFF) / 255,
      green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255,
      alpha: 1)
  }
  #endif
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

  init(rgb: UInt32) {
    self.init(
      red: Double((rgb >> 16) & 0xFF) / 255,
      green: Double((rgb >> 8) & 0xFF) / 255,
      blue: Double(rgb & 0xFF) / 255)
  }
}
