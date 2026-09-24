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
    static let downloadedFonts = "tether.downloadedFonts"
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
    get { availableFonts.first { $0.id == terminalFontID } ?? .menlo }
    set { terminalFontID = newValue.id }
  }

  /// Families fetched from Google Fonts; their files are registered at launch.
  public private(set) var downloadedFonts: [DownloadedFont] {
    didSet {
      UserDefaults.standard.set(try? JSONEncoder().encode(downloadedFonts), forKey: Key.downloadedFonts)
    }
  }

  public var availableFonts: [TerminalFont] {
    TerminalFont.builtIn + downloadedFonts.map(\.terminalFont)
  }

  @ObservationIgnored private let fontInstaller = GoogleFontsInstaller()
  /// One download at a time: two of the same family would swap one folder under each other.
  @ObservationIgnored private var downloading = false

  /// Downloads a family from a Google Fonts link or name and selects it.
  public func downloadFont(_ link: String) async throws {
    guard !downloading else { throw GoogleFontsError.busy }
    downloading = true
    defer { downloading = false }
    // Settle a replace an earlier failure left journaled before starting another.
    let settled = fontInstaller.recoverInterrupted(saved: downloadedFonts)
    if settled != downloadedFonts {
      downloadedFonts = settled.filter { fontInstaller.register($0) }
    }
    let family = GoogleFonts.family(from: link)
    let previous = family.flatMap { name in downloadedFonts.first { $0.slug == GoogleFonts.slug(name) } }
    let installed: GoogleFontsInstaller.Installed
    do {
      installed = try await fontInstaller.install(link, previous: previous)
    } catch {
      // A replace that failed half way may have taken the previous files with it; its
      // journal lets the next launch bring them back.
      if let previous, !fontInstaller.register(previous) { forget(previous) }
      throw error
    }
    let font = installed.font
    guard fontInstaller.register(font) else {
      let restored = fontInstaller.rollback(installed)
      // The replaced files are back; so is their registration. If not, the previous
      // font is gone too, and is no longer offered.
      if let previous, !restored || !fontInstaller.register(previous) { forget(previous) }
      throw GoogleFontsError.unreadable
    }
    downloadedFonts.removeAll { $0.slug == font.slug }
    downloadedFonts.append(font)
    terminalFontID = font.id
    // Only once preferences hold the new record: until then a launch rolls the swap back.
    fontInstaller.commit(installed)
  }

  /// Stops offering a font whose files are gone, without touching disk.
  private func forget(_ font: DownloadedFont) {
    downloadedFonts.removeAll { $0.slug == font.slug }
    if terminalFontID == font.id { terminalFontID = TerminalFont.menlo.id }
  }

  public func removeDownloadedFont(_ font: DownloadedFont) {
    fontInstaller.remove(font)
    downloadedFonts.removeAll { $0.id == font.id }
    if terminalFontID == font.id { terminalFontID = TerminalFont.menlo.id }
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
    var fontID = defaults.string(forKey: Key.terminalFont) ?? TerminalFont.menlo.id
    TerminalFonts.registerBundledFonts()
    // A family whose files are gone (or that Core Text refuses) is no longer offered, and
    // a selection of it falls back to Menlo rather than silently drawing in something else.
    let saved = defaults.data(forKey: Key.downloadedFonts)
      .flatMap { try? JSONDecoder().decode([DownloadedFont].self, from: $0) } ?? []
    let installer = GoogleFontsInstaller()
    let recovered = installer.recoverInterrupted(saved: saved)
    let usable = recovered.filter { installer.register($0) }
    downloadedFonts = usable
    if usable != saved {
      defaults.set(try? JSONEncoder().encode(usable), forKey: Key.downloadedFonts)
    }
    if fontID.hasPrefix("gf-"), !usable.contains(where: { $0.id == fontID }) {
      fontID = TerminalFont.menlo.id
      defaults.set(fontID, forKey: Key.terminalFont)
    }
    terminalFontID = fontID
    let size = defaults.double(forKey: Key.terminalFontSize)
    terminalFontSize = size > 0 ? size : 11
    terminalThemeID = defaults.string(forKey: Key.terminalTheme) ?? TerminalTheme.tether.id
  }
}
