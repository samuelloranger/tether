#if canImport(UIKit)
import SwiftUI

/// The v5 app root: SSH-first. Home is the hub; opening a machine pushes an
/// SSH terminal. A relaunch skips Home and redials the last machine directly.
public struct AppRootView: View {
  @State private var model: HomeModel
  @State private var preferences = AppPreferences()
  @State private var controller: SSHTerminalController?
  @State private var didAutoConnect = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let autoOpenFirst: Bool
  private let pushIdentityProvider: () -> PushRegistrar.PushIdentity?

  public init(pushIdentityProvider: @escaping () -> PushRegistrar.PushIdentity? = { nil }) {
    _model = State(initialValue: .live())
    autoOpenFirst = false
    self.pushIdentityProvider = pushIdentityProvider
  }

  /// DEBUG entry: a seeded model that auto-opens its first machine.
  public init(demoModel: HomeModel) {
    _model = State(initialValue: demoModel)
    autoOpenFirst = true
    pushIdentityProvider = { nil }
  }

  public var body: some View {
    ZStack {
      if let controller {
        SSHTerminalView(controller: controller, preferences: preferences, onHome: leaveTerminal)
          .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
      } else {
        HomeView(model: model, onOpen: open)
          .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
      }
    }
    .animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: controller == nil)
    .preferredColorScheme(preferences.colorSchemePreference.swiftUIColorScheme)
    .task {
      guard !didAutoConnect else { return }
      didAutoConnect = true
      if autoOpenFirst, let first = model.profiles.first { open(first) }
      else if let last = model.lastHostProfile { open(last) }
    }
  }

  private func open(_ profile: SSHHostProfile) {
    guard let config = model.connectionConfig(for: profile) else {
      model.errorMessage = SSHConnectError.missingCredential(name: profile.name).errorDescription
      return
    }
    let attach = ProcessInfo.processInfo.environment["TETHER_SSH_ATTACH"] ?? SSHTerminalController.defaultAttach
    controller = SSHTerminalController(
      title: profile.name, config: config, hostKeyStore: model.hostKeyStore,
      attach: attach, pushIdentity: pushIdentityProvider()
    )
    model.rememberLastHost(profile.id)
  }

  private func leaveTerminal() {
    let leaving = controller
    controller = nil
    model.reload()
    Task { await leaving?.leave() }
  }
}
#endif
