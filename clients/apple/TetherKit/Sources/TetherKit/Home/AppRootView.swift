import SwiftUI

/// The v5 app root: SSH-first. Home is the hub; opening a machine pushes an
/// SSH terminal. A relaunch skips Home and redials the last machine directly.
public struct AppRootView: View {
  @State private var model: HomeModel
  @State private var preferences = AppPreferences()
  @State private var controller: SSHTerminalController?
  /// Mac only: stands in for `controller`, one connection per session tab.
  @State private var tabs: MacSessionTabs?
  @State private var didAutoConnect = false
  @State private var openProfileID: String?
  @State private var chat: ChatTarget?
  @State private var question: AgentQuestionTarget?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let autoOpenFirst: Bool
  private let pushIdentityProvider: () -> PushRegistrar.PushIdentity?
  private let notificationRouter: NotificationTapRouter?
  private let questionRunner: NotificationActionRunner?

  public init(
    pushIdentityProvider: @escaping () -> PushRegistrar.PushIdentity? = { nil },
    notificationRouter: NotificationTapRouter? = nil,
    questionRunner: NotificationActionRunner? = nil
  ) {
    _model = State(initialValue: .live())
    autoOpenFirst = false
    self.pushIdentityProvider = pushIdentityProvider
    self.notificationRouter = notificationRouter
    self.questionRunner = questionRunner
  }

  /// DEBUG entry: a seeded model that auto-opens its first machine.
  public init(demoModel: HomeModel) {
    _model = State(initialValue: demoModel)
    autoOpenFirst = true
    pushIdentityProvider = { nil }
    notificationRouter = nil
    questionRunner = nil
  }

  public var body: some View {
    ZStack {
      if let active = tabs?.activeController ?? controller {
        SSHTerminalView(controller: active, preferences: preferences, questionRunner: questionRunner, tabs: tabs, onHome: leaveTerminal)
          .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
      } else if let chat {
        ChatFlowView(
          list: chat.list, config: chat.config, hostKeyStore: model.hostKeyStore, opening: chat.opening, onClose: leaveChat)
          .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
      } else {
        HomeView(model: model, onOpen: { open($0) }, onChat: { openChat($0) })
          .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
      }
    }
    .animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: terminalOpen || chat != nil)
    .preferredColorScheme(preferences.colorScheme)
    // Here, not on the app's root: a theme change then redraws this view, not the scene.
    .tint(TetherColors.accent)
    .onOpenURL { handle($0) }
    .sheet(item: $question, onDismiss: { Task { for each in allControllers { await each.finishAnsweringQuestion() } } }) { target in
      if let questionRunner {
        AgentQuestionSheet(target: target, runner: questionRunner) { question = nil }
      }
    }
    .task {
      // A tap that launched the app outranks reopening the last machine.
      let linkWaiting = notificationRouter?.hasPendingURL == true || notificationRouter?.hasPendingQuestion == true
      notificationRouter?.onOpenURL = { handle($0) }
      notificationRouter?.onOpenQuestion = { openQuestion($0) }
      guard !didAutoConnect, !linkWaiting else { return }
      didAutoConnect = true
      if autoOpenFirst, let first = model.profiles.first { open(first) }
      else if let last = model.lastHostProfile { open(last) }
    }
    .focusedSceneValue(\.appPreferences, preferences)
    .environment(preferences)
  }

  private var terminalOpen: Bool { tabs != nil || controller != nil }

  private var activeController: SSHTerminalController? { tabs?.activeController ?? controller }

  private var allControllers: [SSHTerminalController] { tabs?.allControllers ?? controller.map { [$0] } ?? [] }

  private func openQuestion(_ target: AgentQuestionTarget) {
    question = target
    guard let controller = tabs?.controller(for: target.link.sessionId) ?? activeController else { return }
    let label = target.link.identityName
    let open = model.profiles.filter { $0.id == openProfileID }
    guard controller.answers(toHostLabel: label) || !NotificationActionRunner.candidates(for: label, in: open).isEmpty
    else { return }
    Task { await controller.beginAnsweringQuestion(in: target.link.sessionId) }
  }

  private func handle(_ url: URL) {
    if let chatLink = DeepLinkCoordinator.parseChat(url.absoluteString) { return handle(chatLink) }
    guard let link = DeepLinkCoordinator.parse(url.absoluteString) else { return }
    didAutoConnect = true
    let labels: Set<String> = activeController?.answers(toHostLabel: link.identityName) == true ? [link.identityName] : []
    switch link.route(profiles: model.profiles, currentProfileID: openProfileID, currentHostLabels: labels) {
    case let .switchSession(session):
      if let tabs { tabs.select(session) } else { Task { await controller?.switchSession(to: session) } }
    case let .open(profileID, session):
      guard let profile = model.profiles.first(where: { $0.id == profileID }) else { return }
      if terminalOpen { leaveTerminal() }
      open(profile, attach: session)
    case .none:
      break
    }
  }

  /// A chat push or link: the terminal screen on that host swaps the chat in. Only a chat list
  /// shown without a terminal takes it in place.
  private func handle(_ link: ChatDeepLink) {
    didAutoConnect = true
    if !terminalOpen, let shown = chat,
       NotificationActionRunner.candidates(for: link.identityName, in: model.profiles.filter { $0.id == shown.profileID }).count == 1
    {
      chat = ChatTarget(list: shown.list, config: shown.config, profileID: shown.profileID, opening: link.chatName)
      return
    }
    let labels: Set<String> = activeController?.answers(toHostLabel: link.identityName) == true ? [link.identityName] : []
    switch link.route(profiles: model.profiles, currentProfileID: openProfileID, currentHostLabels: labels) {
    case let .openHere(name):
      activeController?.requestedChat = name
    case let .open(profileID, name):
      guard let profile = model.profiles.first(where: { $0.id == profileID }) else { return }
      if terminalOpen { leaveTerminal() }
      chat = nil
      open(profile)
      activeController?.requestedChat = name
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
    if TetherPlatform.isMac {
      let theme = preferences.terminalTheme
      let created = MacSessionTabs(
        attach: explicitAttach ?? ProcessInfo.processInfo.environment["TETHER_SSH_ATTACH"],
        pushIdentity: pushIdentityProvider()
      ) { name, choosesInitial, identity in
        SSHTerminalController(
          title: profile.name, config: config, hostKeyStore: model.hostKeyStore,
          attach: name, pushIdentity: identity, theme: theme, choosesInitialSession: choosesInitial
        )
      }
      tabs = created
      Task { await created.start() }
    } else {
      controller = SSHTerminalController(
        title: profile.name, config: config, hostKeyStore: model.hostKeyStore,
        attach: attach, pushIdentity: pushIdentityProvider(), theme: preferences.terminalTheme
      )
    }
    model.rememberLastHost(profile.id)
    openProfileID = profile.id
    let opened = tabs
    let single = controller
    notificationRouter?.coversForegroundPush = { [weak opened, weak single] link in
      if let opened { return await opened.activeController?.coversPush(link) ?? false }
      return await single?.coversPush(link) ?? false
    }
  }

  private struct ChatTarget {
    let list: ChatListModel
    let config: SSHConnectionConfig
    let profileID: String
    var opening: String?
  }

  private func openChat(_ profile: SSHHostProfile) {
    guard let config = model.connectionConfig(for: profile) else {
      model.errorMessage = SSHConnectError.missingCredential(name: profile.name).errorDescription
      return
    }
    chat = ChatTarget(
      list: .live(hostName: profile.name, config: config, hostKeyStore: model.hostKeyStore), config: config,
      profileID: profile.id)
    // No terminal connection here to register from, and the chat's pushes need the host to know this phone.
    if let identity = pushIdentityProvider() {
      let store = model.hostKeyStore
      Task { await PushRegistrar.registerOverSSH(identity: identity, config: config, store: store) }
    }
  }

  private func leaveChat() {
    chat = nil
  }

  private func leaveTerminal() {
    notificationRouter?.coversForegroundPush = nil
    let leaving = controller
    let leavingTabs = tabs
    controller = nil
    tabs = nil
    openProfileID = nil
    model.reload()
    if TetherPlatform.isMac { MacWindowTitle.set("Tether") }
    leavingTabs?.leaveAll()
    Task { await leaving?.leave() }
  }
}
