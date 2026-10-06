import SwiftUI
import UIKit

/// Mac Catalyst window chrome and menu-bar cleanup. Every entry point is a no-op
/// off the Mac, so the iPhone app never calls into UIKit scene APIs it lacks.
public enum TetherMacWindow {
  public static let minimumSize = CGSize(width: 720, height: 480)
  public static let defaultSize = CGSize(width: 1180, height: 760)
  private static let sizedKey = "tether.mac.windowSized"

  /// Hides the app-name title and the empty toolbar, bounds the window below, and
  /// sizes it once on first launch (afterwards the system restores the user's size).
  @MainActor public static func configureScenes() {
    #if targetEnvironment(macCatalyst)
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      scene.titlebar?.titleVisibility = .hidden
      scene.titlebar?.toolbar = nil
      scene.sizeRestrictions?.minimumSize = minimumSize
      sizeOnFirstLaunch(scene)
    }
    #endif
  }

  #if targetEnvironment(macCatalyst)
  @MainActor private static func sizeOnFirstLaunch(_ scene: UIWindowScene) {
    guard !UserDefaults.standard.bool(forKey: sizedKey) else { return }
    UserDefaults.standard.set(true, forKey: sizedKey)
    let origin = scene.effectiveGeometry.systemFrame.origin
    scene.requestGeometryUpdate(
      .Mac(systemFrame: CGRect(origin: origin, size: defaultSize))
    )
  }
  #endif

  /// Menus this app has no use for. Called from the app delegate's `buildMenu`:
  /// SwiftUI's `CommandGroup(replacing:)` cannot remove UIKit's own menus.
  public static func removeDeadMenus(from builder: any UIMenuBuilder) {
    guard builder.system == .main else { return }
    let dead: [UIMenu.Identifier] = [
      .format, .help, .newScene, .document, .openRecent, .print, .share,
      .find, .replace, .spelling, .substitutions, .transformations, .speech,
    ]
    for identifier in dead { builder.remove(menu: identifier) }
  }

  /// Opaque navigation bars in sheets, in the app's own colours.
  @MainActor public static func applyBarAppearance() {
    #if targetEnvironment(macCatalyst)
    let appearance = UINavigationBarAppearance()
    appearance.configureWithOpaqueBackground()
    appearance.backgroundColor = UIColor(TetherColors.background)
    appearance.shadowColor = UIColor(TetherColors.border)
    appearance.titleTextAttributes = [.foregroundColor: UIColor(TetherColors.textPrimary)]
    let bar = UINavigationBar.appearance()
    bar.standardAppearance = appearance
    bar.scrollEdgeAppearance = appearance
    bar.compactAppearance = appearance
    #endif
  }
}
