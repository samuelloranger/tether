import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// Aurora chrome tokens, resolved per appearance. Hex values match desktop
/// `default-dark` / `default-light` in `apps/desktop/src/preferences.ts` — keep in step.
public enum TetherColors {
  public static let background = dynamic(dark: 0x08_08_0E, light: 0xF1_F1_F6)
  public static let surface = dynamic(dark: 0x12_12_1D, light: 0xFF_FF_FF)
  public static let surfaceRaised = dynamic(dark: 0x19_19_26, light: 0xE9_E9_F2)
  public static let input = dynamic(dark: 0x0B_0B_13, light: 0xFF_FF_FF)

  public static let textPrimary = dynamic(dark: 0xED_EE_F6, light: 0x14_14_1B)
  public static let textSecondary = dynamic(dark: 0x97_97_AC, light: 0x5C_5C_6C)
  public static let textFaint = dynamic(dark: 0x61_61_7A, light: 0x8A_8A_9C)

  public static let border = dynamic(dark: 0x23_23_33, light: 0xDC_DC_E6)
  public static let overlay = dynamic(dark: 0x08_08_0E, light: 0x14_14_1B).opacity(0.8)
  public static let selected = dynamic(dark: 0x19_19_26, light: 0xE9_E9_F2)

  public static let accent = dynamic(dark: 0x7C_8C_F8, light: 0x43_53_D0)
  public static let onAccent = dynamic(dark: 0x08_08_0E, light: 0xFF_FF_FF)

  public static let success = dynamic(dark: 0x6E_E7_A8, light: 0x1C_7A_4F)
  public static let warning = dynamic(dark: 0xF2_B3_4C, light: 0x8A_5A_00)
  public static let danger = dynamic(dark: 0xFF_70_50, light: 0xC4_38_1C)
  public static let info = dynamic(dark: 0x7C_8C_F8, light: 0x43_53_D0)

  /// Heat ramp — what the active session is doing. Light values are darkened so
  /// state words stay legible on white.
  public static let heatWorking = dynamic(dark: 0xF2_B3_4C, light: 0x8A_5A_00)
  public static let heatWaiting = dynamic(dark: 0xFF_70_50, light: 0xC4_38_1C)
  public static let heatDone = dynamic(dark: 0x6E_E7_A8, light: 0x1C_7A_4F)
  public static let heatCool = dynamic(dark: 0x7C_8C_F8, light: 0x43_53_D0)

  /// NOT dynamic. Must equal the emulator's cell background — `theme.background` in
  /// `crates/tether-core/src/terminal/alacritty.rs` (0x1E1E2E) — or a seam shows.
  public static let terminalBackgroundHex: UInt32 = 0x1E1E2E
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
