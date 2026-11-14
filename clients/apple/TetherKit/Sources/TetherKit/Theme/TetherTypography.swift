import SwiftUI
import UIKit

/// A face for the app's text or the chat's, picked in Settings.
public struct ReadingFont: Identifiable, Equatable, Sendable {
  public enum Group: String, CaseIterable, Sendable {
    case reading = "Easy reading"
    case clean = "Clean"
    case classic = "Classic"
    case playful = "Playful"
  }

  public let id: String
  public let label: String
  let group: Group
  var note: String?
  /// nil draws the system font in `design`.
  var postScriptName: String?
  var design: Font.Design = .default

  static let system = ReadingFont(id: "system", label: "System", group: .clean)

  public static let all: [ReadingFont] = [
    system,
    ReadingFont(id: "atkinson", label: "Atkinson Hyperlegible", group: .reading,
      note: "Letters that are hard to mistake for each other", postScriptName: "AtkinsonHyperlegibleNext-Regular"),
    ReadingFont(id: "lexend", label: "Lexend", group: .reading,
      note: "Wide spacing for easier reading", postScriptName: "Lexend-Regular"),
    ReadingFont(id: "opendyslexic", label: "OpenDyslexic", group: .reading,
      note: "Weighted letters for readers with dyslexia", postScriptName: "OpenDyslexic-Regular"),
    ReadingFont(id: "rounded", label: "SF Rounded", group: .clean, design: .rounded),
    ReadingFont(id: "mono", label: "SF Mono", group: .clean, design: .monospaced),
    ReadingFont(id: "inter", label: "Inter", group: .clean, postScriptName: "Inter-Regular"),
    ReadingFont(id: "outfit", label: "Outfit", group: .clean, postScriptName: "Outfit-Regular"),
    ReadingFont(id: "spacegrotesk", label: "Space Grotesk", group: .clean, postScriptName: "SpaceGrotesk-Regular"),
    ReadingFont(id: "avenirnext", label: "Avenir Next", group: .clean, postScriptName: "AvenirNext-Regular"),
    ReadingFont(id: "futura", label: "Futura", group: .clean, postScriptName: "Futura-Medium"),
    ReadingFont(id: "gillsans", label: "Gill Sans", group: .clean, postScriptName: "GillSans"),
    ReadingFont(id: "serif", label: "New York", group: .classic, design: .serif),
    ReadingFont(id: "fraunces", label: "Fraunces", group: .classic, postScriptName: "Fraunces-Regular"),
    ReadingFont(id: "georgia", label: "Georgia", group: .classic, postScriptName: "Georgia"),
    ReadingFont(id: "baskerville", label: "Baskerville", group: .classic, postScriptName: "Baskerville"),
    ReadingFont(id: "palatino", label: "Palatino", group: .classic, postScriptName: "Palatino-Roman"),
    ReadingFont(id: "optima", label: "Optima", group: .classic, postScriptName: "Optima-Regular"),
    ReadingFont(id: "didot", label: "Didot", group: .classic, postScriptName: "Didot"),
    ReadingFont(id: "nunito", label: "Nunito", group: .playful, postScriptName: "Nunito-Regular"),
    ReadingFont(id: "comfortaa", label: "Comfortaa", group: .playful, postScriptName: "Comfortaa-Regular"),
    ReadingFont(id: "bricolage", label: "Bricolage Grotesque", group: .playful, postScriptName: "BricolageGrotesque-Regular"),
    ReadingFont(id: "typewriter", label: "American Typewriter", group: .playful, postScriptName: "AmericanTypewriter"),
    ReadingFont(id: "chalkboard", label: "Chalkboard", group: .playful, postScriptName: "ChalkboardSE-Regular"),
    ReadingFont(id: "noteworthy", label: "Noteworthy", group: .playful, postScriptName: "Noteworthy-Light"),
    ReadingFont(id: "markerfelt", label: "Marker Felt", group: .playful, postScriptName: "MarkerFelt-Thin"),
    ReadingFont(id: "caveat", label: "Caveat", group: .playful, note: "Handwritten", postScriptName: "Caveat-Regular"),
  ]

  /// The fonts this device can draw; a system face missing on some OS version is left out.
  static var available: [ReadingFont] {
    TerminalFonts.registerBundledFonts()
    return all.filter { font in font.postScriptName.map { UIFont(name: $0, size: 12) != nil } ?? true }
  }

  static func named(_ id: String) -> ReadingFont? { all.first { $0.id == id } }

  func font(_ style: Font.TextStyle) -> Font {
    guard let postScriptName else { return .system(style, design: design) }
    let font = Font.custom(postScriptName, size: Self.baseSize(style), relativeTo: style)
    return style == .headline ? font.weight(.semibold) : font
  }

  /// Scaled for Dynamic Type, like `UIFont.preferredFont`.
  func uiFont(_ style: UIFont.TextStyle) -> UIFont {
    let system = UIFont.preferredFont(forTextStyle: style)
    if let postScriptName {
      TerminalFonts.registerBundledFonts()
      let base = UIFont.preferredFont(
        forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
      guard let custom = UIFont(name: postScriptName, size: base.pointSize) else { return system }
      return UIFontMetrics(forTextStyle: style).scaledFont(for: custom)
    }
    let uiDesign: UIFontDescriptor.SystemDesign =
      switch design {
      case .rounded: .rounded
      case .serif: .serif
      case .monospaced: .monospaced
      default: .default
      }
    guard let descriptor = system.fontDescriptor.withDesign(uiDesign) else { return system }
    return UIFont(descriptor: descriptor, size: system.pointSize)
  }

  /// The size each text style has at the default Dynamic Type setting.
  private static func baseSize(_ style: Font.TextStyle) -> CGFloat {
    switch style {
    case .largeTitle: 34
    case .title: 28
    case .title2: 22
    case .title3: 20
    case .headline, .body: 17
    case .callout: 16
    case .subheadline: 15
    case .footnote: 13
    case .caption: 12
    case .caption2: 11
    @unknown default: 17
    }
  }
}

/// The faces picked in Settings. Views read them through `Font.app` / `Font.chat` in `body`,
/// so SwiftUI tracks the read and a new pick redraws them.
@Observable
public final class TetherTypography: @unchecked Sendable {
  nonisolated(unsafe) public static let shared = TetherTypography()

  private enum Key {
    static let app = "tether.appFont"
    static let chat = "tether.chatFont"
  }

  public var appFontID: String {
    didSet { UserDefaults.standard.set(appFontID, forKey: Key.app) }
  }

  /// Empty follows the app font.
  public var chatFontID: String {
    didSet { UserDefaults.standard.set(chatFontID, forKey: Key.chat) }
  }

  init() {
    TerminalFonts.registerBundledFonts()
    appFontID = UserDefaults.standard.string(forKey: Key.app) ?? ReadingFont.system.id
    chatFontID = UserDefaults.standard.string(forKey: Key.chat) ?? ""
  }

  public var app: ReadingFont { ReadingFont.named(appFontID) ?? .system }
  public var chat: ReadingFont { ReadingFont.named(chatFontID) ?? app }
}

extension Font {
  /// A text style in the app font picked in Settings.
  static func app(_ style: Font.TextStyle) -> Font { TetherTypography.shared.app.font(style) }
  /// A text style in the chat font picked in Settings.
  static func chat(_ style: Font.TextStyle) -> Font { TetherTypography.shared.chat.font(style) }
}
