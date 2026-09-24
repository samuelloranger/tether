import SwiftUI

@Observable
@MainActor
public final class AppPreferences {
  public enum ColorSchemePreference: String, CaseIterable, Identifiable, Sendable {
    case system
    case dark
    case light

    public var id: String { rawValue }

    public var label: String {
      switch self {
      case .system: "System"
      case .dark: "Dark"
      case .light: "Light"
      }
    }

    public var swiftUIColorScheme: ColorScheme? {
      switch self {
      case .system: nil
      case .dark: .dark
      case .light: .light
      }
    }
  }

  private enum Key {
    static let colorScheme = "tether.colorScheme"
    static let terminalFont = "tether.terminalFont"
    static let terminalFontSize = "tether.terminalFontSize"
    static let terminalTheme = "tether.terminalTheme"
  }

  public var colorSchemePreference: ColorSchemePreference {
    didSet {
      UserDefaults.standard.set(colorSchemePreference.rawValue, forKey: Key.colorScheme)
    }
  }

  public var terminalFontID: String {
    didSet {
      UserDefaults.standard.set(terminalFontID, forKey: Key.terminalFont)
    }
  }

  /// An id no longer offered falls back to Menlo.
  public var terminalFont: TerminalFont {
    get { TerminalFont.named(terminalFontID) }
    set { terminalFontID = newValue.id }
  }

  public var terminalFontSize: Double {
    didSet {
      UserDefaults.standard.set(terminalFontSize, forKey: Key.terminalFontSize)
    }
  }

  public var terminalThemeID: String {
    didSet {
      UserDefaults.standard.set(terminalThemeID, forKey: Key.terminalTheme)
    }
  }

  /// An id no longer in the catalog falls back to Tether's own theme.
  public var terminalTheme: TerminalTheme {
    get { TerminalTheme.named(terminalThemeID) }
    set { terminalThemeID = newValue.id }
  }

  public init() {
    let defaults = UserDefaults.standard
    colorSchemePreference = ColorSchemePreference(
      rawValue: defaults.string(forKey: Key.colorScheme) ?? ""
    ) ?? .dark
    terminalFontID = defaults.string(forKey: Key.terminalFont) ?? TerminalFont.menlo.id
    TerminalFonts.registerBundledFonts()
    let size = defaults.double(forKey: Key.terminalFontSize)
    terminalFontSize = size > 0 ? size : 11
    terminalThemeID = defaults.string(forKey: Key.terminalTheme) ?? TerminalTheme.tether.id
  }
}
