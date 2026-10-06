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
      Button { (terminal?.openSettings ?? home?.openSettings)?() } label: { MenuLabel("Settings…", systemImage: "gearshape") }
        .keyboardShortcut(",", modifiers: .command)
        .disabled(!available.settings)
    }

    CommandGroup(replacing: .newItem) {
      Button { terminal?.newSession?() } label: { MenuLabel("New Session", systemImage: "plus") }
        .keyboardShortcut("t", modifiers: .command)
        .disabled(!available.newSession)
      Button { home?.addMachine?() } label: { MenuLabel("Add Machine…", systemImage: "plus") }
        .keyboardShortcut("n", modifiers: .command)
        .disabled(!available.addMachine)
      Divider()
      Button { terminal?.killSession?() } label: { MenuLabel("Kill Session…", systemImage: "xmark.circle") }
        .disabled(terminal?.killSession == nil)
      Button { terminal?.sendFile?() } label: { MenuLabel("Send File…", systemImage: "square.and.arrow.up") }
        .keyboardShortcut("u", modifiers: [.command, .shift])
        .disabled(terminal?.sendFile == nil)
      Divider()
      Button { terminal?.backToMachines?() } label: { MenuLabel("Back to Machines", systemImage: "chevron.left") }
        .keyboardShortcut("m", modifiers: [.command, .shift])
        .disabled(!available.backToMachines)
    }

    CommandMenu("Session") {
      Button { terminal?.nextSession?() } label: { MenuLabel("Next Session", systemImage: "chevron.right") }
        .keyboardShortcut("]", modifiers: [.command, .shift])
        .disabled(terminal?.nextSession == nil)
      Button { terminal?.previousSession?() } label: { MenuLabel("Previous Session", systemImage: "chevron.left") }
        .keyboardShortcut("[", modifiers: [.command, .shift])
        .disabled(terminal?.previousSession == nil)
      Divider()
      ForEach(0..<9, id: \.self) { index in
        Button("Session \(index + 1)") { terminal?.selectSession?(index) }
          .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
          .disabled(!(terminal?.canSelectSession(at: index) ?? false))
      }
      Divider()
      Button { terminal?.showHistory?() } label: { MenuLabel("History", systemImage: "clock.arrow.circlepath") }
        .keyboardShortcut("h", modifiers: [.command, .shift])
        .disabled(terminal?.showHistory == nil)
      Button { terminal?.showGit?() } label: { MenuLabel("Git", systemImage: "arrow.triangle.branch") }
        .keyboardShortcut("g", modifiers: [.command, .shift])
        .disabled(terminal?.showGit == nil)
    }

    CommandGroup(before: .toolbar) {
      Button { preferences?.makeTerminalTextBigger() } label: { MenuLabel("Bigger", systemImage: "textformat.size.larger") }
        .keyboardShortcut("+", modifiers: .command)
        .disabled(preferences == nil || terminal == nil)
      Button { preferences?.makeTerminalTextSmaller() } label: { MenuLabel("Smaller", systemImage: "textformat.size.smaller") }
        .keyboardShortcut("-", modifiers: .command)
        .disabled(preferences == nil || terminal == nil)
      Button { preferences?.resetTerminalTextSize() } label: { MenuLabel("Actual Size", systemImage: "textformat.size") }
        .keyboardShortcut("0", modifiers: .command)
        .disabled(preferences == nil || terminal == nil)
      Divider()
    }
  }
}
