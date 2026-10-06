import SwiftUI

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
    menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
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
