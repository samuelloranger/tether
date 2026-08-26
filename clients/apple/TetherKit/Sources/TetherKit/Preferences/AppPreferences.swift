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

  public enum TerminalFont: String, CaseIterable, Identifiable, Sendable {
    case menlo = "Menlo"
    case sfMono = "SF Mono"
    case courier = "Courier New"

    public var id: String { rawValue }

    public var label: String {
      switch self {
      case .menlo: "Menlo"
      case .sfMono: "SF Mono"
      case .courier: "Courier"
      }
    }

    /// `UIFont(name:)` resolves PostScript names, not display names — passing
    /// "SF Mono" silently falls back to the system font.
    public var postScriptName: String {
      switch self {
      case .menlo: "Menlo-Regular"
      case .sfMono: "SFMono-Regular"
      case .courier: "CourierNewPSMT"
      }
    }
  }

  private enum Key {
    static let colorScheme = "tether.colorScheme"
    static let terminalFont = "tether.terminalFont"
    static let terminalFontSize = "tether.terminalFontSize"
  }

  public var colorSchemePreference: ColorSchemePreference {
    didSet {
      UserDefaults.standard.set(colorSchemePreference.rawValue, forKey: Key.colorScheme)
    }
  }

  public var terminalFont: TerminalFont {
    didSet {
      UserDefaults.standard.set(terminalFont.rawValue, forKey: Key.terminalFont)
    }
  }

  public var terminalFontSize: Double {
    didSet {
      UserDefaults.standard.set(terminalFontSize, forKey: Key.terminalFontSize)
    }
  }

  public init() {
    let defaults = UserDefaults.standard
    colorSchemePreference = ColorSchemePreference(
      rawValue: defaults.string(forKey: Key.colorScheme) ?? ""
    ) ?? .dark
    terminalFont = TerminalFont(rawValue: defaults.string(forKey: Key.terminalFont) ?? "") ?? .menlo
    let size = defaults.double(forKey: Key.terminalFontSize)
    terminalFontSize = size > 0 ? size : 14
  }
}
