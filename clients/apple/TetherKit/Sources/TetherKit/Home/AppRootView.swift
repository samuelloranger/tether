import SwiftUI

/// The v5 app root: SSH-first. Home is the hub; opening a machine pushes an
/// SSH terminal. A relaunch skips Home and redials the last machine directly.
public struct AppRootView: View {
  @State private var model: HomeModel
  @State private var preferences = AppPreferences()
  @State private var controller: SSHTerminalController?
  @State private var didAutoConnect = false
  @State private var openProfileID: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let autoOpenFirst: Bool
  private let pushIdentityProvider: () -> PushRegistrar.PushIdentity?
  private let notificationRouter: NotificationTapRouter?

  public init(
    pushIdentityProvider: @escaping () -> PushRegistrar.PushIdentity? = { nil },
    notificationRouter: NotificationTapRouter? = nil
  ) {
    _model = State(initialValue: .live())
    autoOpenFirst = false
    self.pushIdentityProvider = pushIdentityProvider
    self.notificationRouter = notificationRouter
  }

  /// DEBUG entry: a seeded model that auto-opens its first machine.
  public init(demoModel: HomeModel) {
    _model = State(initialValue: demoModel)
    autoOpenFirst = true
    pushIdentityProvider = { nil }
    notificationRouter = nil
  }

  public var body: some View {
    ZStack {
      if let controller {
        SSHTerminalView(controller: controller, preferences: preferences, onHome: leaveTerminal)
          .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
      } else {
        HomeView(model: model, onOpen: { open($0) })
          .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
      }
    }
    .animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: controller == nil)
    .preferredColorScheme(preferences.colorSchemePreference.swiftUIColorScheme)
    .onOpenURL { handle($0) }
    .task {
      // A tap that launched the app outranks reopening the last machine.
      let linkWaiting = notificationRouter?.hasPendingURL == true
      notificationRouter?.onOpenURL = { handle($0) }
      guard !didAutoConnect, !linkWaiting else { return }
      didAutoConnect = true
      if autoOpenFirst, let first = model.profiles.first { open(first) }
      else if let last = model.lastHostProfile { open(last) }
    }
  }

  private func handle(_ url: URL) {
    guard let link = DeepLinkCoordinator.parse(url.absoluteString) else { return }
    didAutoConnect = true
    let labels: Set<String> = controller?.answers(toHostLabel: link.identityName) == true ? [link.identityName] : []
    switch link.route(profiles: model.profiles, currentProfileID: openProfileID, currentHostLabels: labels) {
    case let .switchSession(session):
      Task { await controller?.switchSession(to: session) }
    case let .open(profileID, session):
      guard let profile = model.profiles.first(where: { $0.id == profileID }) else { return }
      if controller != nil { leaveTerminal() }
      open(profile, attach: session)
    case .none:
      break
    }
  }

  private func open(_ profile: SSHHostProfile, attach explicitAttach: String? = nil) {
    guard let config = model.connectionConfig(for: profile) else {
      model.errorMessage = SSHConnectError.missingCredential(name: profile.name).errorDescription
      return
    }
    let attach = explicitAttach
      ?? ProcessInfo.processInfo.environment["TETHER_SSH_ATTACH"] ?? SSHTerminalController.defaultAttach
    controller = SSHTerminalController(
      title: profile.name, config: config, hostKeyStore: model.hostKeyStore,
      attach: attach, pushIdentity: pushIdentityProvider(), theme: preferences.terminalTheme
    )
    model.rememberLastHost(profile.id)
    openProfileID = profile.id
    let opened = controller
    notificationRouter?.coversForegroundPush = { [weak opened] link in
      await opened?.coversPush(link) ?? false
    }
  }

  private func leaveTerminal() {
    notificationRouter?.coversForegroundPush = nil
    let leaving = controller
    controller = nil
    openProfileID = nil
    model.reload()
    Task { await leaving?.leave() }
  }
}
