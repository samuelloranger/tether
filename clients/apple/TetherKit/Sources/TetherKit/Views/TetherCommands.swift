import SwiftUI

/// Menu enablement as pure data, so what the bar offers is testable without a scene.
extension TerminalMenuActions {
  public func canSelectSession(at index: Int) -> Bool {
    selectSession != nil && index >= 0 && index < sessionCount
  }
}

public struct MenuAvailability: Equatable {
  public var settings: Bool
  public var newSession: Bool
  public var addMachine: Bool
  public var backToMachines: Bool

  public init(terminal: TerminalMenuActions?, home: HomeMenuActions?) {
    settings = (terminal?.openSettings ?? home?.openSettings) != nil
    newSession = terminal?.newSession != nil
    addMachine = terminal == nil && home?.addMachine != nil
    backToMachines = terminal?.backToMachines != nil
  }
}

public struct TetherCommands: Commands {
  @FocusedValue(\.terminalMenuActions) private var terminal
  @FocusedValue(\.homeMenuActions) private var home
  @FocusedValue(\.appPreferences) private var preferences

  public init() {}

  private var available: MenuAvailability { MenuAvailability(terminal: terminal, home: home) }

  public var body: some Commands {
    CommandGroup(replacing: .appSettings) {
      Button("Settings…") { (terminal?.openSettings ?? home?.openSettings)?() }
        .keyboardShortcut(",", modifiers: .command)
        .disabled(!available.settings)
    }

    CommandGroup(replacing: .newItem) {
      Button("New Session") { terminal?.newSession?() }
        .keyboardShortcut("t", modifiers: .command)
        .disabled(!available.newSession)
      Button("Add Machine…") { home?.addMachine?() }
        .keyboardShortcut("n", modifiers: .command)
        .disabled(!available.addMachine)
      Divider()
      Button("Kill Session…") { terminal?.killSession?() }
        .disabled(terminal?.killSession == nil)
      Button("Send File…") { terminal?.sendFile?() }
        .keyboardShortcut("u", modifiers: [.command, .shift])
        .disabled(terminal?.sendFile == nil)
      Divider()
      Button("Back to Machines") { terminal?.backToMachines?() }
        .keyboardShortcut("m", modifiers: [.command, .shift])
        .disabled(!available.backToMachines)
    }

    CommandMenu("Session") {
      Button("Next Session") { terminal?.nextSession?() }
        .keyboardShortcut("]", modifiers: [.command, .shift])
        .disabled(terminal?.nextSession == nil)
      Button("Previous Session") { terminal?.previousSession?() }
        .keyboardShortcut("[", modifiers: [.command, .shift])
        .disabled(terminal?.previousSession == nil)
      Divider()
      ForEach(0..<9, id: \.self) { index in
        Button("Session \(index + 1)") { terminal?.selectSession?(index) }
          .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
          .disabled(!(terminal?.canSelectSession(at: index) ?? false))
      }
      Divider()
      Button("History") { terminal?.showHistory?() }
        .keyboardShortcut("h", modifiers: [.command, .shift])
        .disabled(terminal?.showHistory == nil)
      Button("Git") { terminal?.showGit?() }
        .keyboardShortcut("g", modifiers: [.command, .shift])
        .disabled(terminal?.showGit == nil)
    }

    CommandGroup(before: .toolbar) {
      Button("Bigger") { preferences?.makeTerminalTextBigger() }
        .keyboardShortcut("+", modifiers: .command)
        .disabled(preferences == nil || terminal == nil)
      Button("Smaller") { preferences?.makeTerminalTextSmaller() }
        .keyboardShortcut("-", modifiers: .command)
        .disabled(preferences == nil || terminal == nil)
      Button("Actual Size") { preferences?.resetTerminalTextSize() }
        .keyboardShortcut("0", modifiers: .command)
        .disabled(preferences == nil || terminal == nil)
      Divider()
    }
  }
}
