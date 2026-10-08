import SwiftUI

@Observable
@MainActor
public final class AppPreferences {
  /// A phone reads 11pt at arm's length; a Mac window sits further away at 1:1 scale.
  #if targetEnvironment(macCatalyst)
  static let defaultTerminalFontSize: Double = 13
  #else
  static let defaultTerminalFontSize: Double = 11
  #endif

  private enum Key {
    /// Gone: the theme decides light or dark. Read once, to migrate.
    static let colorScheme = "tether.colorScheme"
    static let terminalFont = "tether.terminalFont"
    static let terminalFontSize = "tether.terminalFontSize"
    static let terminalLineSpacing = "tether.terminalLineSpacing"
    static let terminalPadding = "tether.terminalPadding"
    static let cursorShape = "tether.cursorShape"
    static let cursorBlink = "tether.cursorBlink"
    static let bellMode = "tether.bellMode"
    static let keyBar = "tether.keyBar"
    static let compactKeys = "tether.compactKeys"
    static let terminalTheme = "tether.terminalTheme"
    static let downloadedFonts = "tether.downloadedFonts"
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

  public var terminalLineSpacing: Double {
    didSet {
      UserDefaults.standard.set(terminalLineSpacing, forKey: Key.terminalLineSpacing)
    }
  }

  /// Side padding around the terminal grid, in points.
  public var terminalPadding: Double {
    didSet {
      UserDefaults.standard.set(terminalPadding, forKey: Key.terminalPadding)
    }
  }

  public var cursorShape: TerminalCursorStyle.Shape {
    didSet {
      UserDefaults.standard.set(cursorShape.rawValue, forKey: Key.cursorShape)
    }
  }

  public var cursorBlink: Bool {
    didSet {
      UserDefaults.standard.set(cursorBlink, forKey: Key.cursorBlink)
    }
  }

  public var bellMode: BellMode {
    didSet {
      UserDefaults.standard.set(bellMode.rawValue, forKey: Key.bellMode)
    }
  }

  public var keyBar: KeyBarLayout {
    didSet {
      UserDefaults.standard.set(keyBar.encoded(), forKey: Key.keyBar)
    }
  }

  /// Smaller keys in the bar above the keyboard.
  public var compactKeys: Bool {
    didSet {
      UserDefaults.standard.set(compactKeys, forKey: Key.compactKeys)
    }
  }

  public var terminalCursorStyle: TerminalCursorStyle {
    TerminalCursorStyle(shape: cursorShape, blink: cursorBlink)
  }

  public var terminalThemeID: String {
    didSet {
      UserDefaults.standard.set(terminalThemeID, forKey: Key.terminalTheme)
      ChromeTheme.shared.apply(terminalTheme)
    }
  }

  /// The theme decides light or dark for everything the app does not draw itself.
  public var colorScheme: ColorScheme { terminalTheme.isLight ? .light : .dark }

  /// The System / Dark / Light setting is gone: someone who saw the light Tether chrome
  /// keeps it as Tether Light. Nil leaves the saved theme as it is.
  nonisolated static func migratedThemeID(savedTheme: String?, savedScheme: String?, systemIsLight: Bool) -> String? {
    guard savedTheme == nil || savedTheme == TerminalTheme.tether.id else { return nil }
    switch savedScheme {
    case "light": return TerminalTheme.tetherLight.id
    case "system" where systemIsLight: return TerminalTheme.tetherLight.id
    default: return nil
    }
  }

  /// An id no longer in the catalog falls back to Tether's own theme.
  public var terminalTheme: TerminalTheme {
    get { TerminalTheme.named(terminalThemeID) }
    set { terminalThemeID = newValue.id }
  }

  public init() {
    let defaults = UserDefaults.standard
    if let scheme = defaults.string(forKey: Key.colorScheme) {
      let migrated = Self.migratedThemeID(
        savedTheme: defaults.string(forKey: Key.terminalTheme), savedScheme: scheme,
        systemIsLight: UITraitCollection.current.userInterfaceStyle == .light
      )
      if let migrated { defaults.set(migrated, forKey: Key.terminalTheme) }
      defaults.removeObject(forKey: Key.colorScheme)
    }
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
    terminalFontSize = size > 0 ? size : Self.defaultTerminalFontSize
    let spacing = defaults.double(forKey: Key.terminalLineSpacing)
    terminalLineSpacing = spacing > 0 ? TerminalLineSpacing.clamped(spacing) : 1
    terminalPadding = defaults.object(forKey: Key.terminalPadding) == nil
      ? Double(TerminalGridInset.defaultPadding)
      : TerminalGridInset.clampedPadding(defaults.double(forKey: Key.terminalPadding))
    cursorShape = TerminalCursorStyle.Shape(rawValue: defaults.string(forKey: Key.cursorShape) ?? "") ?? .block
    cursorBlink = defaults.bool(forKey: Key.cursorBlink)
    bellMode = BellMode(rawValue: defaults.string(forKey: Key.bellMode) ?? "") ?? .off
    keyBar = defaults.data(forKey: Key.keyBar).flatMap(KeyBarLayout.decode) ?? .default
    compactKeys = defaults.bool(forKey: Key.compactKeys)
    terminalThemeID = defaults.string(forKey: Key.terminalTheme) ?? TerminalTheme.tether.id
    #if DEBUG
    // For screenshots: shown, never saved (didSet does not run in init).
    if let id = ProcessInfo.processInfo.environment["TETHER_THEME"] { terminalThemeID = id }
    #endif
    ChromeTheme.shared.apply(terminalTheme)
  }
}
