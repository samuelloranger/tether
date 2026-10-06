import SwiftUI
import UIKit

/// True in the Mac Catalyst build. Mac-only layout and behaviour branch on this,
/// so the iPhone app is unchanged.
public enum TetherPlatform {
  #if targetEnvironment(macCatalyst)
  public static let isMac = true
  #else
  public static let isMac = false
  #endif
}

extension View {
  /// A Mac `Menu` draws as a bordered pull-down with a chevron; an icon menu in a
  /// header should look like the icon buttons beside it.
  @ViewBuilder public func macPlainMenu() -> some View {
    #if targetEnvironment(macCatalyst)
    menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).macMenuIcons()
    #else
    self
    #endif
  }

  /// Mac menus draw a `Label` as its title alone; the phone shows the icon too.
  @ViewBuilder public func macMenuIcons() -> some View {
    #if targetEnvironment(macCatalyst)
    labelStyle(.titleAndIcon)
    #else
    self
    #endif
  }
}

/// What the focused window's terminal offers the Mac menu bar. A nil action
/// disables its menu item, so the menu always reflects what can be done now.
public struct TerminalMenuActions {
  public var newSession: (() -> Void)?
  /// Zero-based position in the session tab strip.
  public var selectSession: ((Int) -> Void)?
  public var nextSession: (() -> Void)?
  public var previousSession: (() -> Void)?
  public var killSession: (() -> Void)?
  public var showHistory: (() -> Void)?
  public var showGit: (() -> Void)?
  public var sendFile: (() -> Void)?
  public var openSettings: (() -> Void)?
  public var backToMachines: (() -> Void)?
  /// Number of tabs in the strip, so Go menu items past the end are disabled.
  public var sessionCount = 0

  public init() {}
}

/// What Home offers the menu bar while no machine is open.
public struct HomeMenuActions {
  public var addMachine: (() -> Void)?
  public var openSettings: (() -> Void)?

  public init() {}
}

private struct TerminalMenuActionsKey: FocusedValueKey {
  typealias Value = TerminalMenuActions
}

private struct HomeMenuActionsKey: FocusedValueKey {
  typealias Value = HomeMenuActions
}

extension FocusedValues {
  public var terminalMenuActions: TerminalMenuActions? {
    get { self[TerminalMenuActionsKey.self] }
    set { self[TerminalMenuActionsKey.self] = newValue }
  }

  public var homeMenuActions: HomeMenuActions? {
    get { self[HomeMenuActionsKey.self] }
    set { self[HomeMenuActionsKey.self] = newValue }
  }
}

private struct AppPreferencesKey: FocusedValueKey {
  typealias Value = AppPreferences
}

extension FocusedValues {
  /// Lets the View menu step the terminal font size.
  public var appPreferences: AppPreferences? {
    get { self[AppPreferencesKey.self] }
    set { self[AppPreferencesKey.self] = newValue }
  }
}

/// A menu item's title and icon. macOS 27 hides menu images unless asked: an app built
/// with the 27 SDK opts in (`titleAndIcon`, `preferredImageVisibility`), while one built
/// with an older SDK has its SF Symbols hidden for good, so it gets a pre-rendered bitmap.
public struct MenuLabel: View {
  private let title: LocalizedStringKey
  private let systemImage: String

  public init(_ title: LocalizedStringKey, systemImage: String) {
    self.title = title
    self.systemImage = systemImage
  }

  public var body: some View {
    Label { Text(title) } icon: { MenuIcon.image(systemImage) }
      .macMenuIcons()
  }
}

public enum MenuIcon {
  #if targetEnvironment(macCatalyst) && !compiler(>=6.4)
  private static let symbolsHidden = true
  #else
  private static let symbolsHidden = false
  #endif

  public static func image(_ systemName: String) -> Image {
    if symbolsHidden, let bitmap = uiImage(systemName) {
      return Image(uiImage: bitmap).renderingMode(.template)
    }
    return Image(systemName: systemName)
  }

  public static func uiImage(_ systemName: String) -> UIImage? {
    guard let symbol = UIImage(systemName: systemName) else { return nil }
    guard symbolsHidden else { return symbol }
    let config = UIImage.SymbolConfiguration(pointSize: 13, weight: .regular)
    guard let sized = UIImage(systemName: systemName, withConfiguration: config) else { return symbol }
    return UIGraphicsImageRenderer(size: sized.size)
      .image { _ in sized.draw(at: .zero) }
      .withRenderingMode(.alwaysTemplate)
  }

  /// A UIKit menu action whose icon shows on the Mac.
  public static func action(
    _ title: String, systemImage: String, attributes: UIMenuElement.Attributes = [],
    handler: @escaping UIActionHandler
  ) -> UIAction {
    let action = UIAction(title: title, image: uiImage(systemImage), attributes: attributes, handler: handler)
    #if targetEnvironment(macCatalyst) && compiler(>=6.4)
    if #available(macCatalyst 27.0, *) { action.preferredImageVisibility = .visible }
    #endif
    return action
  }
}
