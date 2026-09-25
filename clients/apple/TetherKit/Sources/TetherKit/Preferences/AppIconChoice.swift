import UIKit

/// A home-screen icon the app ships. iOS remembers which one is set, not the app.
public struct AppIconChoice: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String

  /// The asset catalog name iOS switches to; nil for the primary icon.
  public var assetName: String? { id == Self.primary.id ? nil : "AppIcon-\(id)" }

  static let primary = AppIconChoice(id: "default", name: "Tether")

  /// Every name but the primary one must be listed in the app target's
  /// ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES, or iOS refuses the switch.
  public static let all: [AppIconChoice] = [primary] + [
    ("mono", "Mono"), ("paper", "Paper"), ("phosphor", "Phosphor"), ("amber", "Amber"),
    ("ember", "Ember"), ("dracula", "Dracula"), ("mocha", "Mocha"), ("nord", "Nord"),
    ("solarized", "Solarized"), ("rose", "Rosé"), ("ocean", "Ocean"), ("synthwave", "Synthwave"),
    ("gold", "Gold"), ("blueprint", "Blueprint"), ("neon", "Neon"), ("pride", "Pride"),
    ("aurora", "Aurora"),
  ].map { AppIconChoice(id: $0.0, name: $0.1) }

  static func current(alternateName: String?) -> AppIconChoice {
    all.first { $0.assetName == alternateName } ?? primary
  }

  var previewURL: URL? {
    Bundle.module.url(forResource: "AppIconPreview-\(id)", withExtension: "png")
  }
}
