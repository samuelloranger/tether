import SwiftUI

public enum TetherColors {
  public static let background = Color(red: 0.07, green: 0.07, blue: 0.10)
  public static let surface = Color(red: 0.11, green: 0.11, blue: 0.15)
  public static let accent = Color(red: 0.53, green: 0.71, blue: 0.98)
  public static let textPrimary = Color.white.opacity(0.92)
  public static let textSecondary = Color.white.opacity(0.55)
  public static let danger = Color(red: 0.95, green: 0.45, blue: 0.45)
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
