import CoreText
import Foundation
import UIKit

/// A face the terminal can draw with. `id` is what preferences store.
public struct TerminalFont: Hashable, Identifiable, Sendable {
  public enum Source: Hashable, Sendable {
    case system, bundled
  }

  public var id: String
  public var label: String
  public var postScriptName: String
  /// Named outright: some families' bold face isn't found through the bold trait.
  public var boldPostScriptName: String?
  public var source: Source

  public init(id: String, label: String, postScriptName: String, boldPostScriptName: String? = nil, source: Source) {
    self.id = id
    self.label = label
    self.postScriptName = postScriptName
    self.boldPostScriptName = boldPostScriptName
    self.source = source
  }

  // The system ids are the raw values the old enum stored, so saved choices survive.
  public static let menlo = TerminalFont(id: "Menlo", label: "Menlo", postScriptName: "Menlo-Regular", source: .system)
  public static let sfMono = TerminalFont(id: "SF Mono", label: "SF Mono", postScriptName: "SFMono-Regular", source: .system)
  public static let courier = TerminalFont(id: "Courier New", label: "Courier", postScriptName: "CourierNewPSMT", source: .system)

  public static let builtIn: [TerminalFont] = [
    .menlo, .sfMono, .courier,
    TerminalFont(id: "jetbrains-mono", label: "JetBrains Mono", postScriptName: "JetBrainsMono-Regular", boldPostScriptName: "JetBrainsMono-Bold", source: .bundled),
    TerminalFont(id: "monaspace-neon", label: "Monaspace Neon", postScriptName: "MonaspaceNeon-Regular", boldPostScriptName: "MonaspaceNeon-Bold", source: .bundled),
    TerminalFont(id: "monaspace-radon", label: "Monaspace Radon", postScriptName: "MonaspaceRadon-Regular", boldPostScriptName: "MonaspaceRadon-Bold", source: .bundled),
    TerminalFont(id: "maple-mono", label: "Maple Mono", postScriptName: "MapleMono-Regular", boldPostScriptName: "MapleMono-Bold", source: .bundled),
    TerminalFont(id: "comic-mono", label: "Comic Mono", postScriptName: "ComicMono", boldPostScriptName: "ComicMono-Bold", source: .bundled),
  ]

  public static func named(_ id: String) -> TerminalFont {
    builtIn.first { $0.id == id } ?? .menlo
  }
}

/// Registers the bundled faces with Core Text and builds the fonts the terminal draws with.
public enum TerminalFonts {
  static let symbolsPostScriptName = "SymbolsNFM"

  private static let bundledFiles = [
    "JetBrainsMono-Regular.ttf", "JetBrainsMono-Bold.ttf",
    "MonaspaceNeon-Regular.otf", "MonaspaceNeon-Bold.otf",
    "MonaspaceRadon-Regular.otf", "MonaspaceRadon-Bold.otf",
    "MapleMono-Regular.ttf", "MapleMono-Bold.ttf",
    "ComicMono.ttf", "ComicMono-Bold.ttf",
    "SymbolsNerdFontMono-Regular.ttf",
  ]

  private static let registration: Void = {
    for file in bundledFiles {
      let name = (file as NSString).deletingPathExtension
      let ext = (file as NSString).pathExtension
      guard let url = Bundle.module.url(forResource: name, withExtension: ext) else { continue }
      // Process scope: nothing outlives the app, and an already-registered face is fine.
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
  }()

  /// Idempotent; cheap after the first call.
  public static func registerBundledFonts() { _ = registration }

  /// The face by PostScript name, else the system monospace, with the Nerd Font symbols
  /// in its cascade list: `CTFontCreateForString` consults that list before the system's,
  /// so prompt icons and powerline glyphs draw instead of empty boxes.
  public static func font(postScriptName: String, size: CGFloat, bold: Bool) -> UIFont {
    registerBundledFonts()
    let boldName = bold ? TerminalFont.builtIn.first { $0.postScriptName == postScriptName }?.boldPostScriptName : nil
    var base: UIFont
    if let boldName, let named = UIFont(name: boldName, size: size) {
      base = named
    } else {
      base = UIFont(name: postScriptName, size: size)
        ?? .monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
      if bold, let descriptor = base.fontDescriptor.withSymbolicTraits(.traitBold) {
        base = UIFont(descriptor: descriptor, size: size)
      }
    }
    let symbols = UIFontDescriptor(fontAttributes: [.name: symbolsPostScriptName])
    let cascaded = base.fontDescriptor.addingAttributes([.cascadeList: [symbols]])
    return UIFont(descriptor: cascaded, size: size)
  }
}
