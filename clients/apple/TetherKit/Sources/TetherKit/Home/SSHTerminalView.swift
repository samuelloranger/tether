import SwiftUI
import UIKit
import UniformTypeIdentifiers
import PhotosUI

/// The terminal screen: header + slide-over session sidebar + terminal, backed by
/// SSH + zmx. Home is reached from the bottom of the sidebar.
public struct SSHTerminalView: View {
  @Bindable var controller: SSHTerminalController
  var preferences: AppPreferences
  var onHome: () -> Void
  /// Set on Mac: `controller` is then the active tab's.
  private let tabs: MacSessionTabs?
  private let questionRunner: NotificationActionRunner?
  @State private var answering: AgentQuestionTarget?

  @State private var focused = false
  @State private var accessory = TerminalAccessoryModel()
  @State private var drawerOpen = false
  /// Opening the drawer takes the keyboard; closing it hands it back.
  @State private var focusedBeforeDrawer = false
  /// Live horizontal drag on the drawer, `nil` when no finger is on it.
  @State private var dragTranslation: CGFloat?
  @State private var showSettings = false
  @State private var showGit = false
  /// Set by a row's Git menu item; nil means the open chat's folder, else the attached session.
  @State private var gitOverride: GitTarget?
  @State private var endedExpanded = false
  @State private var collapsedProjects: Set<String> = []
  @State private var showingArchive = false
  @State private var chatActions: DrawerChatRow?
  @State private var renamingChat: DrawerChatRow?
  @State private var chatNewTitle = ""
  @State private var archivedChat: DrawerChatRow?
  @State private var pendingContinue: PendingContinue?
  @State private var selectionText: String?
  /// The one destructive route: every "kill" entry point sets this, and the
  /// single confirmation dialog is the only thing that acts on it.
  @State private var pendingKill: String?
  @State private var pendingChatKill: DrawerChatRow?
  /// The main area: the terminal, or a chat swapped in over it. The terminal stays attached under a chat.
  @State private var content = DrawerContent()
  @State private var showNewChat = false
  @State private var newChatMode: NewChatSheet.Mode = .new
  @State private var newChatAgent: ChatAgentProfile?
  @State private var newChatOptionsOpen = false
  @State private var newChatChanges: [String: String] = [:]
  @State private var showFileImporter = false
  @State private var showHistory = false
  @State private var showPhotoPicker = false
  @State private var photoItem: PhotosPickerItem?
  @State private var showCopyConfirmation = false
  @State private var promptNotice: String?
  /// Bumped per bell that should flash; drives the flash's keyframes.
  @State private var bellFlashes = 0
  @Environment(\.scenePhase) private var scenePhase
  @State private var backgroundDetach = BackgroundDetach()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  /// The drawer holds text, so it grows with it — but never past the screen.
  @ScaledMetric(relativeTo: .body) private var drawerWidth: CGFloat = 280
  @ScaledMetric(relativeTo: .title3) private var tapTarget: CGFloat = 40
  @ScaledMetric(relativeTo: .caption2) private var lampSize: CGFloat = 9
  @ScaledMetric(relativeTo: .caption2) private var glyphSlot: CGFloat = 14

  public init(
    controller: SSHTerminalController, preferences: AppPreferences,
    questionRunner: NotificationActionRunner? = nil, tabs: MacSessionTabs? = nil, onHome: @escaping () -> Void
  ) {
    self.tabs = tabs
    self.controller = controller
    self.preferences = preferences
    self.questionRunner = questionRunner
    self.onHome = onHome
  }

  public var body: some View {
    presentations(core)
  }

  // Split from `presentations` so the type checker keeps up with the modifier chain.
  private var core: some View {
    ZStack(alignment: .leading) {
      terminalStack
        .opacity(content.showsChat ? 0 : 1)
        .allowsHitTesting(!content.showsChat)
        .accessibilityHidden(content.showsChat)
        .ignoresSafeArea(.keyboard, edges: content.showsChat ? .bottom : [])
      if let route = content.chat {
        EmbeddedChat(
          route: route, controller: controller, needsYou: drawerNeedsYou, onSessions: { setDrawer(open: true) },
          onContinueInTerminal: { id, cwd in await continueInTerminal(chat: route.name, sessionId: id, cwd: cwd) },
          onOpenChat: openChat)
          .id(route.name)
      }
      if drawerProgress > 0 {
        Color.black.opacity(0.5 * min(drawerProgress, 1)).ignoresSafeArea()
          .onTapGesture { setDrawer(open: false) }
          .transition(.opacity)
        drawer
          // Past fully open the panel stretches rather than tearing away from
          // the edge, so the pull still reads as the finger being heard.
          .frame(width: panelWidth * max(1, drawerProgress))
          .offset(x: -panelWidth * (1 - min(drawerProgress, 1)))
          // A drag mounts the panel outside an animation, so it appears exactly
          // under the finger; the button mounts it inside one, and it slides.
          .transition(TetherMotion.drawerTransition(reduceMotion: reduceMotion))
      }
    }
    .overlay(alignment: .bottom) {
      transferBanner.animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: controller.transfer)
    }
    .copyConfirmation(isPresented: $showCopyConfirmation)
    .overlay(alignment: .top) {
      if let promptNotice {
        transferPill { Label(promptNotice, systemImage: "text.line.first.and.arrowtriangle.forward") }
          .padding(.top, 56)
          .onTapGesture { self.promptNotice = nil }
          .task(id: promptNotice) {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            self.promptNotice = nil
          }
      }
    }
    .overlay {
      if tabs == nil { drawerGestures }
    }
    .sensoryFeedback(trigger: controller.status) {
      switch controller.status {
      case .connected: .success
      case .disconnected: .warning
      case .failed: .error
      case .connecting: nil
      }
    }
    .sensoryFeedback(trigger: controller.transfer) {
      switch controller.transfer {
      case .sent: .success
      case .failed: .error
      case .idle, .sending: nil
      }
    }
    .sensoryFeedback(.selection, trigger: controller.attach)
    .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item]) { result in
      guard case let .success(url) = result else { return }
      let stop = url.startAccessingSecurityScopedResource()
      let data = try? Data(contentsOf: url)
      if stop { url.stopAccessingSecurityScopedResource() }
      guard let data else { return }
      Task { await controller.sendFile(data: data, filename: url.lastPathComponent) }
    }
    .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .any(of: [.images, .videos]))
    .onChange(of: photoItem) { _, item in
      guard let item else { return }
      Task {
        defer { photoItem = nil }
        await send(item)
      }
    }
    .task(id: ObjectIdentifier(controller)) {
      if tabs == nil {
        controller.startNetworkWatch()
        await controller.connect()
      }
      #if DEBUG
      if ProcessInfo.processInfo.environment["TETHER_SSH_DRAWER"] != nil { drawerOpen = true }
      await applyDebugDrawerMode()
      if ProcessInfo.processInfo.environment["TETHER_SSH_GIT"] != nil { showGit = true }
      if let name = ProcessInfo.processInfo.environment["TETHER_SSH_SENDFILE"] {
        await controller.sendFile(data: Data("tether upload test\n".utf8), filename: name)
      }
      #endif
    }
    .task(id: "\(ObjectIdentifier(controller).hashValue)-\(scenePhase == .active && controller.status == .connected)") {
      while !Task.isCancelled, scenePhase == .active, controller.status == .connected {
        await controller.refreshAgentStatus()
        if !controller.chats.isEmpty { await controller.refreshChats() }
        try? await Task.sleep(nanoseconds: 5_000_000_000)
      }
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active:
        if let tabs {
          tabs.enterForeground()
          refocusOnMac()
        } else {
          backgroundDetach.end(controller: controller)
          Task { await controller.enterForeground() }
        }
      case .background:
        // A hidden or minimized Mac window is still a desktop terminal: nothing detaches.
        if tabs == nil { backgroundDetach.begin(controller: controller) }
      default:
        break
      }
    }
    .task(id: scenePhase == .active) {
      guard let tabs, scenePhase == .active else { return }
      while !Task.isCancelled {
        await tabs.refresh()
        try? await Task.sleep(nanoseconds: 10_000_000_000)
      }
    }
    .onChange(of: controller.status) { _, status in
      if status == .connected, let tabs { Task { await tabs.refresh() } }
    }
    .onChange(of: windowTitle, initial: true) { _, title in
      if tabs != nil { MacWindowTitle.set(title) }
    }
    .onChange(of: controller.hasSession) { _, has in
      if !has && !TetherPlatform.isMac { focused = false }
    }
    .task(id: "usage-\(drawerOpen)-\(scenePhase == .active)-\(controller.status == .connected)") {
      guard drawerOpen, scenePhase == .active, controller.status == .connected else { return }
      while !Task.isCancelled {
        await controller.refreshPlanUsage()
        try? await Task.sleep(nanoseconds: 60_000_000_000)
      }
    }
    .onChange(of: drawerOpen) { _, open in
      if open { focusedBeforeDrawer = focused } else if focusedBeforeDrawer, !content.showsChat { focused = true }
    }
    .onChange(of: controller.requestedChat, initial: true) { _, name in
      guard let name else { return }
      controller.requestedChat = nil
      openChat(ChatRoute.opening(
        name: name, chats: controller.chats, journal: UserDefaultsChatJournalStore(name: name).load(),
        localAgent: controller.chatTitles.agent(for: name)))
    }
    .onChange(of: controller.sessionSwitches) { _, _ in
      if content.showsChat { showTerminal() }
    }
    .onChange(of: drawerProgress > 0 || content.showsChat, initial: true) { _, hidden in accessory.visible = !hidden }
    .onChange(of: modalOpen) { _, open in
      guard tabs != nil else { return }
      if open { focused = false } else { refocusOnMac() }
    }
    .onChange(of: ObjectIdentifier(controller)) { refocusOnMac() }
    .onAppear { refocusOnMac() }
    .focusedSceneValue(\.terminalMenuActions, menuActions)
  }

  private func presentations(_ base: some View) -> some View {
    base
    .sheet(item: $answering, onDismiss: { Task { await controller.refreshAgentStatus() } }) { target in
      if let questionRunner {
        AgentQuestionSheet(target: target, runner: questionRunner) { answering = nil }
      }
    }
    .sheet(isPresented: $showSettings) {
      TerminalSettingsSheet(preferences: preferences) { showSettings = false }
        .macSheetSize(width: 560, height: 680)
    }
    .sheet(isPresented: $showNewChat) {
      NewChatSheet(
        initialFolder: controller.activeSessionCwd ?? "~",
        initialMode: newChatMode,
        initialAgent: newChatAgent,
        initiallyOpenOptions: newChatOptionsOpen,
        initialChanges: newChatChanges,
        storedDefaults: { ChatOptionDefaultsStore().stored(agent: $0.key) },
        cachedOptions: { controller.cachedOptions(agent: $0) },
        onAgentPicked: { ChatLastAgentStore().set($0) },
        checkAgents: { await controller.unavailableAgents() },
        onStart: { folder, request in
          switch await controller.newChat(cwdText: folder, request: request) {
          case let .failed(message): return message
          case let .ready(route):
            showNewChat = false
            openChat(route)
            return nil
          }
        },
        loadSessions: { await controller.savedSessions(folderText: $0, agent: $1) },
        onContinue: { folder, session, request in
          switch await controller.continueChat(session: session, folderText: folder, request: request) {
          case let .failed(message): return message
          case let .ready(route):
            showNewChat = false
            openChat(route)
            return nil
          }
        },
        onCancel: { showNewChat = false }
      )
    }
    .sheet(isPresented: $showGit, onDismiss: { gitOverride = nil; controller.setGitTarget(.session) }) {
      GitDiffView(controller: controller) { showGit = false }
        // Set again on appear: a sheet queued behind a chat's own Git sheet opens after that one reset it.
        .onAppear {
          controller.setGitTarget(gitOverride ?? content.chat.map { GitTarget.forChat(folder: $0.cwd) } ?? .session)
        }
        .macSheetSize(width: 900, height: 640, large: true)
    }
    .sheet(isPresented: $showHistory) {
      TerminalHistoryView(controller: controller, preferences: preferences) { showHistory = false }
        .macSheetSize(width: 900, height: 640, large: true)
    }
    .destructiveConfirmation(
      $pendingKill,
      title: { "Kill \($0)?" },
      actionLabel: "Kill session",
      message: "Everything running in this session stops."
    ) { name in
      if let tabs { tabs.kill(name) } else { Task { await controller.killSession(name) } }
    }
    .confirmationDialog(chatActions?.title ?? "Chat", isPresented: Binding(
      get: { chatActions != nil }, set: { if !$0 { chatActions = nil } }), titleVisibility: .visible
    ) {
      if let row = chatActions {
        Button(row.pinned ? "Unpin chat" : "Pin chat") { updateChat(row, patch: ["pinned": !row.pinned]) }
        Button("Rename…") { chatNewTitle = row.title; renamingChat = row }
        Button(row.archived ? "Restore chat" : "Archive chat") {
          updateChat(row, patch: ["archived": !row.archived], archive: !row.archived)
        }
        Button("Delete…", role: .destructive) { pendingChatKill = row }
      }
    }
    .alert("Rename chat", isPresented: Binding(get: { renamingChat != nil }, set: { if !$0 { renamingChat = nil } })) {
      TextField("Chat name", text: $chatNewTitle)
      Button("Save") {
        if let row = renamingChat { updateChat(row, patch: ["title": chatNewTitle.trimmingCharacters(in: .whitespacesAndNewlines)]) }
        renamingChat = nil
      }
      Button("Cancel", role: .cancel) { renamingChat = nil }
    }
    .alert(
      "Continue in a terminal?",
      isPresented: Binding(get: { pendingContinue != nil }, set: { if !$0 { pendingContinue = nil } })
    ) {
      Button("Continue") {
        guard let pending = pendingContinue else { return }
        pendingContinue = nil
        setDrawer(open: false)
        Task {
          if let reason = await continueInTerminal(chat: pending.chat, sessionId: pending.sessionId, cwd: pending.cwd) {
            promptNotice = reason
          }
        }
      }
      Button("Cancel", role: .cancel) { pendingContinue = nil }
    } message: {
      Text("The chat ends here and Claude Code picks the conversation up in a new terminal session.")
    }
    .destructiveConfirmation(
      $pendingChatKill,
      title: { "Delete \($0.title)?" },
      actionLabel: "Delete chat",
      message: "The agent stops and the conversation is removed from the host."
    ) { row in
      content.chatKilled(row.name)
      Task { await controller.killChat(row.name) }
    }
  }

  /// Two Claude Codes on one conversation would both write it, so the chat's agent ends first; if
  /// the host does not confirm that, the chat stays and the reason is returned for it to show.
  private func continueInTerminal(chat: String, sessionId: String, cwd: String) async -> String? {
    guard await controller.endChatAgent(chat) else {
      return "Couldn't end the chat on the host, so it stays here. Try again."
    }
    await controller.forgetChat(chat)
    let name = "claude-" + String(sessionId.prefix(8))
    let command = ZmxSwitch.resumeCommand(sessionId: sessionId, cwd: cwd)
    showTerminal()
    if let tabs { tabs.open(name, running: command) } else { await controller.openSession(name, running: command) }
    return nil
  }

  private func openChat(_ route: ChatRoute) {
    focused = false
    focusedBeforeDrawer = false
    content.open(route)
    setDrawer(open: false)
  }

  private func showTerminal() {
    guard content.showsChat else { return }
    content.showTerminal()
  }

  private var terminalStack: some View {
    VStack(spacing: 0) {
      header
      if let tabs {
        MacSessionStrip(tabs: tabs, onKill: { pendingKill = $0 })
      }
      ZStack {
        TetherSurfaceRepresentable(
          frames: controller.frames,
          sessionKey: controller.sessionKey,
          fontName: preferences.terminalFont.postScriptName,
          fontSize: preferences.terminalFontSize,
          lineSpacing: preferences.terminalLineSpacing,
          horizontalPadding: preferences.terminalPadding,
          cursorStyle: preferences.terminalCursorStyle,
          theme: preferences.terminalTheme,
          onGridSizeChange: { controller.updateGrid(cols: $0, rows: $1) },
          onGridSizeSettled: { controller.updateGridServer(cols: $0, rows: $1) },
          onCellPixelSize: { controller.updateCellPixelSize(width: $0, height: $1) },
          onScrollLines: { controller.scroll(lines: $0) },
          onTap: { focused = true },
          onSelectionText: { selectionText = $0 },
          onOpenURL: { UIApplication.shared.open($0) },
          // The file is on the host, not the phone: hand over its path instead.
          onOpenFile: { path, line, column in
            let location = LinkTarget.file(path: path, line: line, column: column).text
            acknowledgeCopy(location, announce: "Path copied", into: $showCopyConfirmation)
          },
          onCopyLink: { acknowledgeCopy($0, into: $showCopyConfirmation) },
          onMouseBytes: { controller.sendInput($0) },
          mouseMode: controller.mouseMode,
          mouseSgr: controller.mouseSgr,
          freezesGrid: drawerOpen || modalOpen || content.showsChat
        )
        .accessibilityIdentifier("sshTerminalSurface")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(preferences.terminalTheme.backgroundColor)
        .onChange(of: preferences.terminalTheme.id) { controller.requestTheme(preferences.terminalTheme) }
        .id(ObjectIdentifier(controller))
        statusOverlay
        emptyStateOverlay
        bellFlashOverlay
      }
      .overlay(alignment: .bottom) { heldQuestionBanner }
      // Over the terminal, not above it: in the stack it took rows from the grid, and the
      // host saw a resize when it came and another when it expired.
      .overlay(alignment: .top) { agentAlertBanner }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .onChange(of: controller.bellRings) { ringBell() }
      .onChange(of: preferences.keyBar, initial: true) { accessory.layout = preferences.keyBar }
      .onChange(of: preferences.compactKeys, initial: true) { accessory.compact = preferences.compactKeys }
      TerminalInputBridge(
        accessory: TetherPlatform.isMac ? AnyView(EmptyView()) : AnyView(
          TerminalAccessoryBar(
            model: accessory,
            onKey: { controller.sendInput($0) },
            onPaste: { controller.sendPaste($0) },
            onArrow: { controller.sendInput($0.escapeSequence) },
            onHideKeyboard: { focused = false }
          )
        ),
        // Kept while the drawer is open (dropping it resized the grid under the drawer), but
        // faded: it lives in the keyboard's window, so it would draw over the drawer.
        showsAccessory: !TetherPlatform.isMac,
        accessoryInteractive: drawerProgress == 0,
        compactAccessory: preferences.compactKeys,
        onSubmitBytes: submit,
        isFocused: $focused
      )
      .id(ObjectIdentifier(controller))
      .frame(height: 1)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(preferences.terminalTheme.backgroundColor.ignoresSafeArea())
    .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: controller.agentAlert?.id)
    .animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: controller.heldQuestion?.version)
  }

  /// A session or a chat other than the one on screen is waiting on an answer.
  private var drawerNeedsYou: Bool {
    controller.othersWaiting || DrawerChatRows.othersWaiting(chats: controller.chats, open: content.chat?.name)
  }

  private var header: some View {
    HStack(spacing: 4) {
      if tabs == nil {
        headerButton("line.3.horizontal", id: "sshTerminalDrawer",
                     label: drawerNeedsYou ? "Open session list, a session needs you" : "Open session list") {
          setDrawer(open: true)
        }
        .overlay(alignment: .topTrailing) {
          if drawerNeedsYou {
            Circle().fill(TetherColors.warning).frame(width: 8, height: 8).offset(x: -8, y: 8)
              .accessibilityHidden(true)
          }
        }
      }
      Circle().fill(lampColor).frame(width: lampSize, height: lampSize).padding(.leading, tabs == nil ? 4 : 8)
        .shadow(color: lampColor.opacity(0.55), radius: 4)
        .scaleEffect(controller.status == .connected ? 1 : 1.12)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 0) {
        Text(controller.title).font(.subheadline.weight(.semibold))
          .foregroundStyle(TetherColors.textPrimary)
        HStack(spacing: 4) {
          Text(sessionLabel)
          Text("·")
          // State is spelled out as well as coloured — the lamp alone would be
          // invisible to Differentiate Without Color and to VoiceOver.
          Text(statusLabel).foregroundStyle(lampColor)
        }
        .font(.caption2.monospaced())
        .foregroundStyle(TetherColors.textFaint)
      }
      .padding(.leading, 6)
      .lineLimit(1)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("\(controller.title), session \(controller.attach), \(statusLabel)")
      Spacer()
      headerButton("arrow.triangle.branch", id: "sshTerminalGit", label: "Git changes") { showGit = true }
      headerButton("gearshape", id: "sshTerminalSettings", label: "Terminal settings") { showSettings = true }
      Menu {
        Group {
          Button(action: newSession) { MenuLabel("New session", systemImage: "plus") }
          Button { showFileImporter = true } label: { MenuLabel("Send file…", systemImage: "square.and.arrow.up") }
          Button { showPhotoPicker = true } label: { MenuLabel("Send photo or video…", systemImage: "photo") }
          Button(action: copySelection) { MenuLabel("Copy selection", systemImage: "doc.on.doc") }
            .disabled(selectionText?.isEmpty ?? true)
          Button { showHistory = true } label: { MenuLabel("Terminal history", systemImage: "clock.arrow.circlepath") }
          Divider()
          Button { jump(.previous) } label: { MenuLabel("Previous prompt", systemImage: "chevron.up") }
          Button { jump(.next) } label: { MenuLabel("Next prompt", systemImage: "chevron.down") }
          Button(action: copyLastOutput) { MenuLabel("Copy last output", systemImage: "text.badge.checkmark") }
          Divider()
          Button(role: .destructive) { pendingKill = controller.attach } label: { MenuLabel("Kill \(controller.attach)", systemImage: "xmark.circle") }
        }
        .macMenuIcons()
      } label: {
        Image(systemName: "ellipsis").font(.title3.weight(.semibold))
          .frame(width: tapTarget, height: tapTarget).contentShape(Rectangle())
      }
      .macPlainMenu()
      .accessibilityIdentifier("sshTerminalOverflow")
      .accessibilityLabel("More terminal actions")
    }
    .foregroundStyle(TetherColors.accent)
    .animation(TetherMotion.ui(TetherMotion.arrive, reduceMotion: reduceMotion), value: controller.status)
    .padding(.horizontal, 10).padding(.vertical, 6)
    // Up under the status bar too, or the strip there shows the terminal's colour.
    .background(TetherColors.surface.ignoresSafeArea(edges: .top))
    .overlay(alignment: .bottom) {
      if let progress = controller.terminalReport.progress { progressBar(progress) }
    }
  }

  private func progressBar(_ progress: TerminalProgress) -> some View {
    let tint: Color = switch progress.state {
    case .error: TetherColors.danger
    case .warning: TetherColors.warning
    case .normal, .indeterminate: TetherColors.accent
    }
    return Group {
      if progress.state == .indeterminate {
        ProgressView().progressViewStyle(.linear)
      } else {
        ProgressView(value: Double(progress.percent), total: 100).progressViewStyle(.linear)
      }
    }
    .tint(tint)
    .scaleEffect(y: 0.6)
    .accessibilityElement()
    .accessibilityLabel(progress.state == .indeterminate ? "Working" : "Progress")
    .accessibilityValue(progress.state == .indeterminate ? "" : "\(progress.percent) percent")
    .accessibilityIdentifier("sshTerminalProgress")
  }

  private func headerButton(_ icon: String, id: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon).font(.title3.weight(.semibold))
        .frame(width: tapTarget, height: tapTarget).contentShape(Rectangle())
    }
    .buttonStyle(TetherPressStyle())
    .accessibilityIdentifier(id)
    .accessibilityLabel(label)
  }

  private var drawer: some View {
    let chatRows = DrawerLayout.waitingFirst(
      DrawerChatRows.rows(
        chats: controller.chats, titles: controller.chatTitles.titles(for: controller.chats.map(\.name)),
        agents: controller.chatTitles.agents(for: controller.chats.map(\.name)))
    ) { $0.state == .waiting }
    let sessions = DrawerLayout.waitingFirst(controller.sessions) { controller.agentStatuses[$0.name]?.state == .waiting }
    let folders = DrawerLayout.sessionFolders(controller.sessions)
    let visible = chatRows.filter { !$0.archived }
    let archived = chatRows.filter(\.archived)
    let pinned = visible.filter(\.pinned)
    let groups = ChatOrganization.groups(chatRows)
    let attention = ChatOrganization.attention(chatRows)
    return VStack(alignment: .leading, spacing: 0) {
      drawerHeader(terminals: sessions.count, chats: visible.count)
      Divider().overlay(TetherColors.border)
      ScrollView {
        VStack(spacing: 8) {
          if !sessions.isEmpty { sectionHeader("Terminals", count: sessions.count) }
          ForEach(sessions) { sessionRow($0, folder: folders[$0.name]) }
          if sessions.isEmpty && chatRows.isEmpty {
            Text("Nothing running yet. Use + to start a terminal or a chat.")
              .font(.caption.monospaced()).multilineTextAlignment(.leading)
              .foregroundStyle(TetherColors.textFaint).padding(.top, 4)
          }
          if showingArchive {
            Button { showingArchive = false } label: {
              Label("Archived chats", systemImage: "chevron.backward").font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            Text("History stays available. Archiving does not stop an agent.")
              .font(.caption).foregroundStyle(TetherColors.textSecondary)
            ForEach(archived) { chatRow($0) }
            if archived.isEmpty { Text("No archived chats.").font(.caption).foregroundStyle(TetherColors.textSecondary) }
          } else {
            if !attention.isEmpty {
              sectionHeader("Needs you · archived", count: attention.count)
              ForEach(attention) { chatRow($0) }
            }
            if !pinned.isEmpty {
              sectionHeader("Pinned", count: pinned.count)
              ForEach(pinned) { chatRow($0) }
            }
            if !groups.isEmpty { sectionHeader("Projects", count: groups.count) }
            ForEach(groups) { group in
              Button {
                if collapsedProjects.contains(group.path) { collapsedProjects.remove(group.path) }
                else { collapsedProjects.insert(group.path) }
              } label: {
                HStack(spacing: 6) {
                  Image(systemName: collapsedProjects.contains(group.path) ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                  Image(systemName: "folder").font(.caption)
                  Text(group.title).font(.caption.weight(.semibold))
                  Spacer(minLength: 0)
                }
                .foregroundStyle(TetherColors.textSecondary).frame(minHeight: 36).contentShape(Rectangle())
              }
              .buttonStyle(TetherPressStyle()).accessibilityLabel(group.path)
              .accessibilityValue(collapsedProjects.contains(group.path) ? "collapsed" : "expanded")
              if !collapsedProjects.contains(group.path) { ForEach(group.rows) { chatRow($0) } }
            }
            Button { showingArchive = true } label: {
              HStack { Label("Archived chats", systemImage: "archivebox"); Spacer(); Text("\(archived.count)") }
                .font(.caption).foregroundStyle(TetherColors.textSecondary).frame(minHeight: 44)
            }
            .accessibilityIdentifier("drawerArchive")
          }
        }
        .padding(.horizontal, 12).padding(.bottom, 12)
      }
      if let archivedChat {
        HStack {
          Text("Chat archived").font(.caption)
          Spacer()
          Button("Undo") { updateChat(archivedChat, patch: ["archived": false]); self.archivedChat = nil }
            .font(.caption.weight(.semibold)).frame(minHeight: 44)
        }.padding(.horizontal, 16).background(TetherColors.surfaceRaised)
      }
      Divider().overlay(TetherColors.border)
      ChatPlanUsageView(usage: controller.planUsage, loading: controller.planUsageLoading, host: controller.title)
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .background(TetherColors.background.ignoresSafeArea())
    .accessibilityIdentifier("sshSessionDrawer")
    .accessibilityAction(.escape) { setDrawer(open: false) }
  }

  private var drawerStateLabel: String {
    if case .connected = controller.status { return "connected" }
    return statusLabel
  }

  private func drawerHeader(terminals: Int, chats: Int) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Text(controller.title).font(.subheadline.weight(.semibold))
          .foregroundStyle(TetherColors.textPrimary).lineLimit(1)
        Spacer(minLength: 4)
        Button {
          setDrawer(open: false)
          onHome()
        } label: {
          Text("Switch").font(.footnote.weight(.semibold)).foregroundStyle(TetherColors.accent)
            .padding(.horizontal, 6).frame(minHeight: max(44, tapTarget)).contentShape(Rectangle())
        }
        .buttonStyle(TetherPressStyle())
        .accessibilityIdentifier("sshDrawerHome")
        .accessibilityLabel("Switch machine")
        Menu {
          Button(action: startNewTerminal) { Label("New terminal", systemImage: "terminal") }
            .accessibilityIdentifier("sshNewTerminal")
          Button { newChatMode = .new; showNewChat = true } label: { Label("New chat…", systemImage: "bubble.left") }
            .accessibilityIdentifier("sshNewChat")
          Button { newChatMode = .resume; showNewChat = true } label: {
            Label("Continue a chat…", systemImage: "arrow.counterclockwise")
          }
          .accessibilityIdentifier("sshContinueChat")
        } label: {
          Image(systemName: "plus").font(.body.weight(.semibold)).foregroundStyle(TetherColors.accent)
            .frame(width: max(44, tapTarget), height: max(44, tapTarget)).contentShape(Rectangle())
        }
        .accessibilityIdentifier("sshNewSessionAdd")
        .accessibilityLabel("New terminal or chat")
      }
      HStack(alignment: .firstTextBaseline, spacing: 5) {
        Circle().fill(lampColor).frame(width: 6, height: 6).accessibilityHidden(true)
        Text(DrawerLayout.summary(state: drawerStateLabel, terminals: terminals, chats: chats))
          .font(.caption2).foregroundStyle(TetherColors.textFaint)
      }
      .padding(.bottom, 8)
      .accessibilityElement(children: .combine)
    }
    .padding(.leading, 14).padding(.trailing, 6).padding(.top, 4)
  }

  private func sectionHeader(_ title: String, count: Int) -> some View {
    HStack(spacing: 6) {
      Text(title)
      Text("\(count)")
    }
    .font(.caption2.weight(.semibold)).tracking(0.6).textCase(.uppercase)
    .foregroundStyle(TetherColors.textFaint)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 2).padding(.top, 10)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }

  private func endedDisclosure(count: Int, expanded: Bool) -> some View {
    Button {
      withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) { endedExpanded = !expanded }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
          .rotationEffect(.degrees(expanded ? 90 : 0))
        Text("Ended · \(count)").font(.caption.monospaced())
        Spacer()
      }
      .foregroundStyle(TetherColors.textFaint)
      .padding(.horizontal, 4).frame(minHeight: 44).contentShape(Rectangle())
    }
    .buttonStyle(TetherPressStyle())
    .accessibilityIdentifier("drawerEndedToggle")
    .accessibilityLabel("Ended chats, \(count)")
    .accessibilityValue(expanded ? "expanded" : "collapsed")
  }

  /// The one row shape for sessions and chats: the glyph and two lines on the left, only the kill control
  /// trailing. The kill control stays visible: keyboard and VoiceOver users never need the context menu,
  /// and a full-swipe kill would destroy work without a prompt.
  private func drawerRow<Main: View>(
    selected: Bool, needsYou: Bool, ended: Bool = false,
    killID: String, killLabel: String, killSymbol: String = "xmark", onKill: @escaping () -> Void,
    @ViewBuilder main: () -> Main
  ) -> some View {
    HStack(spacing: 6) {
      main()
      Button(action: onKill) {
        Image(systemName: killSymbol).font(.footnote.weight(.semibold))
          .foregroundStyle(TetherColors.textFaint.opacity(0.6))
          .frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .padding(.trailing, -12).padding(.vertical, -6)
      .accessibilityIdentifier(killID)
      .accessibilityLabel(killLabel)
      .accessibilityHint("Asks to confirm first")
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
    .modifier(DrawerRowChrome(selected: selected, needsYou: needsYou, ended: ended))
    .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: selected)
  }

  private func sessionRow(_ session: ZmxSession, folder: String?) -> some View {
    let isCurrent = controller.hasSession && session.name == controller.attach
    let isSelected = isCurrent && !content.showsChat
    let agent = controller.agentStatuses[session.name]
    let showsDetail = DynamicTypeLayout.showsDetail(for: dynamicTypeSize)
    let shownFolder = showsDetail ? folder : nil
    let hasStatus = agent != nil || isCurrent
    return drawerRow(
      selected: isSelected, needsYou: agent?.state == .waiting,
      killID: "zmxKill_\(session.name)", killLabel: "Kill session \(session.name)",
      onKill: { pendingKill = session.name }
    ) {
      Button {
        openSession(session.name)
      } label: {
        HStack(alignment: .top, spacing: 10) {
          // The dot repeats what the label already says, so it can go when text
          // needs the room; "attached" is never carried by colour alone.
          Circle().fill(isCurrent ? TetherColors.success : TetherColors.textFaint)
            .frame(width: lampSize, height: lampSize)
            .frame(width: glyphSlot).padding(.top, 4)
          VStack(alignment: .leading, spacing: 2) {
            Text(session.name).font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
              .lineLimit(1)
            if shownFolder != nil || hasStatus {
              HStack(spacing: 4) {
                if let shownFolder {
                  Text(shownFolder).foregroundStyle(TetherColors.textFaint).lineLimit(1).truncationMode(.middle)
                  if hasStatus { Text("·").foregroundStyle(TetherColors.textFaint) }
                }
                if let agent {
                  TimelineView(.periodic(from: .now, by: 60)) { context in
                    AgentStatusTag(status: agent, now: context.date)
                  }
                  .fixedSize()
                } else if isCurrent {
                  Text("attached").foregroundStyle(TetherColors.success).fixedSize()
                }
              }
              .font(.caption2.monospaced())
              .accessibilityHidden(true)
            }
          }
          Spacer(minLength: 4)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("zmxSession_\(session.name)")
      .accessibilityLabel(sessionAccessibilityLabel(session, isCurrent: isCurrent))
      .accessibilityHint(isCurrent ? "Already attached" : "Attaches this session")
      .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
    .contextMenu {
      Button { openSession(session.name) } label: { Label("Open", systemImage: "terminal") }
      Button {
        acknowledgeCopy(session.name, announce: "Name copied", into: $showCopyConfirmation)
      } label: { Label("Copy name", systemImage: "doc.on.doc") }
      if let git = DrawerLayout.gitTarget(cwd: session.displayCwd, isAttached: isCurrent) {
        Button { openGit(git) } label: { Label("Git", systemImage: "arrow.triangle.branch") }
      }
      Button(role: .destructive) { pendingKill = session.name } label: { Label("Kill", systemImage: "xmark.circle") }
    }
  }

  private func openSession(_ name: String) {
    showTerminal()
    focusedBeforeDrawer = true
    Task { await controller.switchSession(to: name) }
    setDrawer(open: false)
  }

  /// The Git sheet over a row's folder, whichever session or chat is in front.
  private func openGit(_ target: GitTarget) {
    gitOverride = target
    showGit = true
  }

  private func chatSubtitle(_ row: DrawerChatRow, agentLabel: String?, folder: Bool) -> some View {
    HStack(spacing: 4) {
      if let agentLabel {
        Text(agentLabel).foregroundStyle(TetherColors.textFaint).lineLimit(1).fixedSize()
        Text("·").foregroundStyle(TetherColors.textFaint)
      }
      if folder {
        Text(row.subtitle).foregroundStyle(TetherColors.textFaint).lineLimit(1).truncationMode(.middle)
        Text("·").foregroundStyle(TetherColors.textFaint)
      }
      ChatStateTag(state: row.state)
    }
  }

  private func chatRow(_ row: DrawerChatRow) -> some View {
    let isSelected = content.isSelected(chat: row.name)
    let ended = row.state == .ended
    let showsDetail = DynamicTypeLayout.showsDetail(for: dynamicTypeSize)
    return drawerRow(
      selected: isSelected, needsYou: row.state == .waiting, ended: ended,
      killID: "chatActions_\(row.name)", killLabel: "Actions for \(row.title)", killSymbol: "ellipsis",
      onKill: { chatActions = row }
    ) {
      Button {
        openChat(controller.chatRoute(for: row))
      } label: {
        HStack(alignment: .top, spacing: 10) {
          ChatAgentMark(agent: row.agent, size: glyphSlot + 2)
            .opacity(ended ? 0.55 : 1)
            .frame(width: glyphSlot).padding(.top, 1)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 2) {
            Text(row.title).font(.subheadline.weight(.semibold))
              .foregroundStyle(ended ? TetherColors.textSecondary : TetherColors.textPrimary)
              .lineLimit(2).multilineTextAlignment(.leading)
            Group {
              if let agentLabel = row.agentLabel, showsDetail {
                let fits = DrawerLayout.chatSubtitleFits
                ViewThatFits(in: .horizontal) {
                  chatSubtitle(row, agentLabel: fits[0].agentLabel ? agentLabel : nil, folder: fits[0].folder)
                    .fixedSize(horizontal: true, vertical: false)
                  chatSubtitle(row, agentLabel: fits[1].agentLabel ? agentLabel : nil, folder: fits[1].folder)
                    .fixedSize(horizontal: true, vertical: false)
                  chatSubtitle(row, agentLabel: fits[2].agentLabel ? agentLabel : nil, folder: fits[2].folder)
                    .fixedSize(horizontal: true, vertical: false)
                }
              } else {
                chatSubtitle(row, agentLabel: nil, folder: showsDetail)
              }
            }
            .font(.caption2.monospaced())
            .accessibilityHidden(true)
          }
          Spacer(minLength: 4)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("chatRow_\(row.name)")
      .accessibilityLabel("Chat \(row.title), \(row.agentLabel.map { "\($0), " } ?? "")\(row.stateLabel), \(row.subtitle)")
      .accessibilityHint(isSelected ? "Already open" : "Opens this chat")
      .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
    .contextMenu {
      Button { openChat(controller.chatRoute(for: row)) } label: { Label("Open", systemImage: "bubble.left") }
      Button {
        acknowledgeCopy(row.cwd, announce: "Folder copied", into: $showCopyConfirmation)
      } label: { Label("Copy folder", systemImage: "folder") }
      if let git = DrawerLayout.gitTarget(cwd: row.cwd, isAttached: false) {
        Button { openGit(git) } label: { Label("Git", systemImage: "arrow.triangle.branch") }
      }
      ContinueInTerminalItem(row: row) { pendingContinue = $0 }
      Button { updateChat(row, patch: ["pinned": !row.pinned]) } label: {
        Label(row.pinned ? "Unpin chat" : "Pin chat", systemImage: row.pinned ? "pin.slash" : "pin")
      }
      Button { chatNewTitle = row.title; renamingChat = row } label: { Label("Rename…", systemImage: "pencil") }
      Button { updateChat(row, patch: ["archived": !row.archived], archive: !row.archived) } label: {
        Label(row.archived ? "Restore chat" : "Archive chat", systemImage: row.archived ? "arrow.uturn.backward" : "archivebox")
      }
      Button(role: .destructive) { pendingChatKill = row } label: { Label("Delete", systemImage: "trash") }
    }
  }

  private func updateChat(_ row: DrawerChatRow, patch: [String: Any], archive: Bool = false) {
    Task {
      if let failure = await controller.organizeChat(row.name, patch: patch) { promptNotice = failure }
      else if archive { archivedChat = row }
    }
  }

  private func sessionAccessibilityLabel(_ session: ZmxSession, isCurrent: Bool) -> String {
    var parts = [session.name, isCurrent ? "attached" : "not attached"]
    if let agent = controller.agentStatuses[session.name] {
      parts.append("agent \(AgentStatusTag.label(for: agent, now: Date()))")
    }
    if DynamicTypeLayout.showsDetail(for: dynamicTypeSize) {
      parts.append(session.displayCwd)
      if session.clients > 0 { parts.append("\(session.clients) client\(session.clients == 1 ? "" : "s")") }
    }
    return parts.joined(separator: ", ")
  }

  private func send(_ item: PhotosPickerItem) async {
    let isVideo = MediaTransfer.isVideo(contentTypes: item.supportedContentTypes)
    await controller.sendPickedMedia(item, isVideo: isVideo)
  }

  private func startNewTerminal() {
    showTerminal()
    focusedBeforeDrawer = true
    Task { await controller.createSession(nextSessionName()) }
    setDrawer(open: false)
  }

  /// Folds latched Ctrl/Alt into typed input so the keyboard can produce Ctrl+C, Alt+B etc.
  private func submit(_ text: String) {
    let ctrl = accessory.ctrlArmed && TerminalKeyMap.ctrlFolded(text) != nil
    let alt = accessory.altArmed && text.count == 1
    guard ctrl || alt else {
      controller.sendInput(text)
      return
    }
    if ctrl { accessory.ctrlArmed = false }
    if alt { accessory.altArmed = false }
    controller.sendInput(TerminalKeyMap.modified(text, ctrl: ctrl, alt: alt))
  }

  private func newSession() {
    if let tabs { tabs.beginNewSession() } else {
      Task { await controller.createSession(nextSessionName()) }
    }
  }

  private func goToSession(_ name: String) {
    if let tabs { tabs.select(name) } else { Task { await controller.switchSession(to: name) } }
  }

  private var windowTitle: String { "\(controller.title) · \(controller.attach)" }

  private var modalOpen: Bool {
    showSettings || showGit || showHistory || showFileImporter || showPhotoPicker
      || pendingKill != nil || pendingChatKill != nil || showNewChat || answering != nil || tabs?.draftName != nil
  }

  /// A desktop terminal takes typing without a click. Flipped off and on because the
  /// bridge only reacts to a change of the binding.
  private func refocusOnMac() {
    guard tabs != nil, !modalOpen else { return }
    focused = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
      if !modalOpen { focused = true }
    }
  }

  private var menuActions: TerminalMenuActions? {
    guard let tabs else { return nil }
    var actions = TerminalMenuActions()
    actions.newSession = { tabs.beginNewSession() }
    actions.selectSession = { tabs.selectIndex($0) }
    actions.nextSession = { tabs.step(1) }
    actions.previousSession = { tabs.step(-1) }
    actions.killSession = { pendingKill = tabs.state.active }
    actions.showHistory = { showHistory = true }
    // The menu bar's Git follows what is in front: a chat's folder, else the session's.
    actions.showGit = {
      if let route = content.chat { controller.setGitTarget(GitTarget.forChat(folder: route.cwd)) }
      showGit = true
    }
    actions.sendFile = { showFileImporter = true }
    actions.openSettings = { showSettings = true }
    actions.backToMachines = onHome
    actions.sessionCount = tabs.state.names.count
    return actions
  }

  #if DEBUG
  /// `TETHER_DEBUG_DRAWER`: `open` the drawer over the terminal, `chat` a chat swapped in,
  /// `chat-open` the drawer over that chat, `newchat` the folder sheet.
  private func applyDebugDrawerMode() async {
    guard let mode = ProcessInfo.processInfo.environment["TETHER_DEBUG_DRAWER"] else { return }
    try? await Task.sleep(nanoseconds: 600_000_000)
    await controller.refreshSessions()
    let row = DrawerChatRows.rows(chats: controller.chats, titles: controller.chatTitles.titles(for: controller.chats.map(\.name)), agents: controller.chatTitles.agents(for: controller.chats.map(\.name))).first
    switch mode {
    case "chat", "chat-open":
      if let row { content.open(controller.chatRoute(for: row)) }
      if mode == "chat-open" { try? await Task.sleep(nanoseconds: 700_000_000); drawerOpen = true }
    case "projects-archive": showingArchive = true; drawerOpen = true
    case "newchat": showNewChat = true
    case "newchat-claude", "newchat-codex-open", "newchat-opencode-first":
      newChatAgent = mode == "newchat-claude" ? ChatAgents.claude : mode == "newchat-codex-open" ? ChatAgents.codex : ChatAgents.opencode
      newChatOptionsOpen = mode != "newchat-claude"
      if mode == "newchat-codex-open" { newChatChanges = ["reasoning_effort": "high"] }
      showNewChat = true
    case "newchat-continue", "newchat-continue-empty", "newchat-continue-error", "newchat-continue-recent":
      newChatMode = .resume
      showNewChat = true
    case "pick": break
    default: drawerOpen = true
    }
  }
  #endif

  private func nextSessionName() -> String {
    var n = controller.sessions.count + 1
    let names = Set(controller.sessions.map(\.name))
    while names.contains("session-\(n)") { n += 1 }
    return "session-\(n)"
  }

  private var lampColor: Color {
    switch controller.status {
    case .connecting, .disconnected: return TetherColors.warning
    case .connected: return TetherColors.success
    case .failed: return TetherColors.danger
    }
  }

  private var sessionLabel: String {
    if case .connected = controller.status, !controller.hasSession { return "no session" }
    return controller.terminalReport.title ?? controller.attach
  }

  private var statusLabel: String {
    SSHTerminalController.connectionCopy(
      status: controller.status, reachability: controller.reachability
    )?.shortLabel ?? "live"
  }

  /// The drag lives in UIKit (see `DrawerGestureHost`) and takes no touches itself;
  /// the header button stays the primary, assistive-tech route in.
  private var drawerGestures: some View {
    DrawerGestureHost(
      isOpen: { drawerOpen },
      onBegan: { dragTranslation = 0 },
      onChanged: { dragTranslation = $0 },
      onEnded: { translation, velocity in
        let open = DrawerDragDecision.settlesOpen(
          isOpen: drawerOpen, translationX: translation, velocityX: velocity, width: panelWidth)
        let wasOpen = drawerOpen
        withAnimation(TetherMotion.drawerSettle(reduceMotion: reduceMotion)) {
          dragTranslation = nil
          drawerOpen = open
        }
        if open, !wasOpen { Task { await controller.refreshSessions() } }
      },
      onCancelled: {
        withAnimation(TetherMotion.drawerSettle(reduceMotion: reduceMotion)) { dragTranslation = nil }
      }
    )
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  private var panelWidth: CGFloat { min(max(drawerWidth, 320), 390) }

  /// Where the panel sits right now: the live drag if there is one, otherwise
  /// the settled state.
  private var drawerProgress: Double {
    guard let dragTranslation else { return drawerOpen ? 1 : 0 }
    return DrawerDragDecision.progress(isOpen: drawerOpen, translationX: dragTranslation, width: panelWidth)
  }

  private func setDrawer(open: Bool) {
    withAnimation(TetherMotion.drawerSettle(reduceMotion: reduceMotion)) {
      dragTranslation = nil
      drawerOpen = open
    }
    if open { Task { await controller.refreshSessions() } }
  }

  private func jump(_ direction: PromptJump) {
    Task {
      if await !controller.jumpToPrompt(direction) {
        await showPromptNotice(direction == .previous ? "No earlier prompt" : "No later prompt")
      }
    }
  }

  private func copyLastOutput() {
    Task {
      guard let output = await controller.lastCommandOutput() else {
        await showPromptNotice("No finished command to copy")
        return
      }
      acknowledgeCopy(output, into: $showCopyConfirmation)
    }
  }

  /// Prompt navigation reads the shell's OSC 133 marks; a shell that emits none finds nothing.
  private func showPromptNotice(_ message: String) async {
    promptNotice = PromptNotice.text(message, shellMarksPrompts: await controller.shellMarksPrompts())
  }

  private func copySelection() {
    guard let text = selectionText, !text.isEmpty else { return }
    acknowledgeCopy(text, into: $showCopyConfirmation)
  }

  @ViewBuilder
  private var agentAlertBanner: some View {
    if let alert = controller.agentAlert {
      AgentAlertBanner(
        alert: alert,
        onOpen: { goToSession(alert.session) },
        onDismiss: { controller.dismissAgentAlert() }
      )
      .transition(.opacity)
      .task(id: "\(alert.session)-\(alert.since.timeIntervalSince1970)") {
        guard let lifetime = alert.bannerLifetime else { return }
        try? await Task.sleep(nanoseconds: UInt64(lifetime * 1_000_000_000))
        controller.expireAgentAlert(alert)
      }
    }
  }

  @ViewBuilder
  private var heldQuestionBanner: some View {
    if questionRunner != nil, let question = controller.heldQuestion {
      HeldQuestionBanner(
        status: question,
        onAnswer: {
          answering = AgentQuestionTarget(
            link: SessionDeepLink(sessionId: question.session, identityName: question.hostLabel ?? controller.title),
            expect: AgentExpectation(state: question.state.rawValue, version: question.version)
          )
        },
        onDismiss: { controller.dismissHeldQuestion() }
      )
      .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
    }
  }

  @ViewBuilder
  private var transferBanner: some View {
    switch controller.transfer {
    case .idle:
      EmptyView()
    case let .sending(name):
      transferPill { HStack(spacing: 8) { ProgressView().tint(TetherColors.accent); Text("Sending \(name)…") } }
    case let .sent(path):
      transferPill { Label("Sent to \(path)", systemImage: "checkmark.circle") }
        .task { try? await Task.sleep(nanoseconds: 2_500_000_000); controller.clearTransfer() }
    case let .failed(message):
      transferPill { Label(message, systemImage: "exclamationmark.triangle") }
        .onTapGesture { controller.clearTransfer() }
    }
  }

  private func transferPill(@ViewBuilder _ content: () -> some View) -> some View {
    content()
      .font(.caption.monospaced())
      .foregroundStyle(TetherColors.textPrimary)
      .padding(.horizontal, 14).padding(.vertical, 10)
      .background(TetherColors.surface.opacity(0.95), in: Capsule())
      .overlay(Capsule().strokeBorder(TetherColors.border))
      .padding(.bottom, 24).padding(.horizontal, 16)
      .shadow(radius: 8, y: 2)
      .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
  }

  private static let bellHaptic = UIImpactFeedbackGenerator(style: .medium)

  private func ringBell() {
    let mode = preferences.bellMode
    if mode.haptic { Self.bellHaptic.impactOccurred() }
    if mode.flash { bellFlashes += 1 }
  }

  private var bellFlashOverlay: some View {
    let peak = reduceMotion ? 0.08 : 0.18
    return Color(uiColor: TerminalTheme.uiColor(preferences.terminalTheme.foreground))
      .keyframeAnimator(initialValue: 0.0, trigger: bellFlashes) { flash, opacity in
        flash.opacity(opacity)
      } keyframes: { _ in
        LinearKeyframe(peak, duration: 0.02)
        LinearKeyframe(0, duration: reduceMotion ? 0.3 : 0.15)
      }
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }

  /// One overlay for every not-connected state. The copy comes from the controller so
  /// a network blocker and an SSH failure can never be confused.
  @ViewBuilder
  private var statusOverlay: some View {
    if let copy = SSHTerminalController.connectionCopy(
      status: controller.status, reachability: controller.reachability
    ) {
      VStack(spacing: 12) {
        switch copy.indicator {
        case .spinner:
          ProgressView().tint(TetherColors.accent)
        case let .warning(symbol):
          Image(systemName: symbol).font(.largeTitle).foregroundStyle(TetherColors.warning)
        case let .error(symbol):
          Image(systemName: symbol).font(.largeTitle).foregroundStyle(TetherColors.danger)
        }
        Text(copy.message).font(.footnote.monospaced())
          .foregroundStyle(TetherColors.textSecondary).multilineTextAlignment(.center)
        if copy.indicator.offersRetry {
          Button("Retry") { Task { await controller.connect(trigger: .manual) } }
            .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.onAccent)
            .padding(.horizontal, 20).padding(.vertical, 10)
            .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 11))
            .buttonStyle(TetherPressStyle())
            .accessibilityIdentifier("sshTerminalRetry")
        }
      }
      .padding(24).frame(maxWidth: 320)
      .background(TetherColors.surface.opacity(0.95), in: RoundedRectangle(cornerRadius: 16))
      .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
      .accessibilityElement(children: .contain)
      .accessibilityLabel(copy.message)
      .accessibilityIdentifier("sshTerminalStatus")
    }
  }

  /// Shown while no zmx session is attached: the app never opens one by itself, so the
  /// terminal stays gated until the user picks a session here or starts one. It covers the
  /// whole grid — underneath is the bare login shell, or whatever the last session left behind.
  @ViewBuilder
  private var emptyStateOverlay: some View {
    if case .connected = controller.status, !controller.hasSession {
      ZStack {
        preferences.terminalTheme.backgroundColor
        emptyStateCard
      }
      .transition(.opacity)
    }
  }

  /// Newest first; the drawer has the rest.
  private var pickableSessions: [ZmxSession] {
    Array(controller.sessions.sorted { $0.created > $1.created }.prefix(6))
  }

  private var emptyStateCard: some View {
    VStack(spacing: 14) {
      Image(systemName: "terminal").font(.largeTitle).foregroundStyle(TetherColors.textSecondary)
      Text(controller.sessions.isEmpty ? "No session on \(controller.title)" : "Open a session on \(controller.title)")
        .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
        .multilineTextAlignment(.center)
      if controller.sessions.isEmpty {
        Text("Nothing runs until you start one.")
          .font(.caption.monospaced()).foregroundStyle(TetherColors.textFaint)
      } else {
        VStack(spacing: 6) {
          ForEach(pickableSessions) { session in
            Button { goToSession(session.name) } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(session.name).font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
                Text(session.displayCwd).font(.caption2.monospaced())
                  .foregroundStyle(TetherColors.textFaint).lineLimit(1).truncationMode(.head)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 12).padding(.vertical, 8)
              .background(TetherColors.background, in: RoundedRectangle(cornerRadius: 10))
              .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
            }
            .buttonStyle(TetherPressStyle())
            .accessibilityIdentifier("sshEmptyStateSession_\(session.name)")
          }
          if controller.sessions.count > pickableSessions.count, tabs == nil {
            Button("All sessions") { setDrawer(open: true) }
              .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.accent)
          }
        }
      }
      Button("New session") {
        if let tabs { tabs.beginNewSession() } else {
          setDrawer(open: true)
        }
      }
      .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.onAccent)
      .padding(.horizontal, 20).padding(.vertical, 10)
      .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 11))
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("sshEmptyStateNew")
    }
    .padding(24).frame(maxWidth: 300)
    .background(TetherColors.surface.opacity(0.95), in: RoundedRectangle(cornerRadius: 16))
  }
}

/// The fill and outline of a drawer row: a selected row is tinted with an accent bar, an outline marks
/// a row that needs an answer, and an ended chat is drawn as an empty dashed slot.
private struct DrawerRowChrome: ViewModifier {
  let selected: Bool
  let needsYou: Bool
  let ended: Bool

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: 12)
    content
      .background(selected && !ended ? TetherColors.accent.opacity(0.10) : .clear, in: shape)
      .background(ended ? Color.clear : TetherColors.surface, in: shape)
      .overlay(alignment: .leading) {
        if selected { Rectangle().fill(TetherColors.accent).frame(width: 3) }
      }
      .clipShape(shape)
      .overlay {
        if needsYou {
          shape.strokeBorder(TetherColors.warning.opacity(0.7), lineWidth: 1.5)
        } else if ended {
          shape.strokeBorder(TetherColors.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        } else {
          shape.strokeBorder(TetherColors.border)
        }
      }
  }
}

private struct PendingContinue: Equatable {
  let chat: String
  let sessionId: String
  let cwd: String
}

/// Reads the chat's journal only when the context menu is built, not on every drawer frame.
private struct ContinueInTerminalItem: View {
  let row: DrawerChatRow
  let onContinue: (PendingContinue) -> Void

  var body: some View {
    if let id = DrawerLayout.resumableSessionId(row, journal: UserDefaultsChatJournalStore(name: row.name).load()) {
      Button { onContinue(PendingContinue(chat: row.name, sessionId: id, cwd: row.cwd)) } label: {
        Label("Continue in terminal", systemImage: "terminal")
      }
    }
  }
}
