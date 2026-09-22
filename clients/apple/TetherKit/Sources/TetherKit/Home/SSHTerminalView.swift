#if canImport(UIKit)
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import PhotosUI

/// The v5 terminal screen: header + slide-over session sidebar + terminal,
/// matching the old layout but backed by SSH + zmx. Home is reached from the
/// bottom of the sidebar.
public struct SSHTerminalView: View {
  @Bindable var controller: SSHTerminalController
  var preferences: AppPreferences
  var onHome: () -> Void

  @State private var input = ""
  @State private var focused = false
  @State private var accessory = TerminalAccessoryModel()
  @State private var drawerOpen = false
  @State private var showSettings = false
  @State private var showGit = false
  @State private var newSessionName = ""
  @State private var selectionText: String?
  /// The one destructive route: every "kill" entry point sets this, and the
  /// single confirmation dialog is the only thing that acts on it.
  @State private var pendingKill: String?
  @State private var showFileImporter = false
  @State private var showHistory = false
  @State private var showPhotoPicker = false
  @State private var photoItem: PhotosPickerItem?
  @State private var copyFeedback = 0
  @State private var showCopyConfirmation = false
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  /// The drawer holds text, so it grows with it — but never past the screen.
  @ScaledMetric(relativeTo: .body) private var drawerWidth: CGFloat = 280
  @ScaledMetric(relativeTo: .title3) private var tapTarget: CGFloat = 40
  @ScaledMetric(relativeTo: .caption2) private var lampSize: CGFloat = 9

  public init(controller: SSHTerminalController, preferences: AppPreferences, onHome: @escaping () -> Void) {
    self.controller = controller
    self.preferences = preferences
    self.onHome = onHome
  }

  public var body: some View {
    ZStack(alignment: .leading) {
      terminalStack
      if drawerOpen {
        Color.black.opacity(0.5).ignoresSafeArea()
          .onTapGesture { withAnimation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion)) { drawerOpen = false } }
          .transition(.opacity)
        drawer
          .frame(width: min(drawerWidth, 360))
          .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
          .gesture(drawerCloseDrag)
      }
    }
    .animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: drawerOpen)
    .overlay(alignment: .bottom) {
      transferBanner.animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: controller.transfer)
    }
    .overlay(alignment: .bottom) {
      copyConfirmation.animation(TetherMotion.ui(TetherMotion.feedback, reduceMotion: reduceMotion), value: showCopyConfirmation)
    }
    .overlay(alignment: .leading) { drawerEdgeGesture }
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
    .sensoryFeedback(.success, trigger: copyFeedback)
    .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item]) { result in
      guard case let .success(url) = result else { return }
      let stop = url.startAccessingSecurityScopedResource()
      let data = try? Data(contentsOf: url)
      if stop { url.stopAccessingSecurityScopedResource() }
      guard let data else { return }
      Task { await controller.sendFile(data: data, filename: url.lastPathComponent) }
    }
    .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .images)
    .onChange(of: photoItem) { _, item in
      guard let item else { return }
      Task {
        defer { photoItem = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
        let remote = await controller.sendFile(data: data, filename: "photo-\(Int(Date().timeIntervalSince1970)).\(ext)")
        // Drop the uploaded path at the shell prompt so it can be used directly.
        if let remote { controller.sendInput(shellQuote(remote)) }
      }
    }
    .task {
      controller.startNetworkWatch()
      await controller.connect()
      #if DEBUG
      if ProcessInfo.processInfo.environment["TETHER_SSH_DRAWER"] != nil { drawerOpen = true }
      if ProcessInfo.processInfo.environment["TETHER_SSH_GIT"] != nil { showGit = true }
      if let name = ProcessInfo.processInfo.environment["TETHER_SSH_SENDFILE"] {
        await controller.sendFile(data: Data("tether upload test\n".utf8), filename: name)
      }
      #endif
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await controller.reconnectIfNeeded() } }
    }
    .sheet(isPresented: $showSettings) { TerminalSettingsSheet(preferences: preferences) { showSettings = false } }
    .sheet(isPresented: $showGit) { GitDiffView(controller: controller) { showGit = false } }
    .sheet(isPresented: $showHistory) {
      TerminalHistoryView(controller: controller, preferences: preferences) { showHistory = false }
    }
    .confirmationDialog(
      "Kill \(pendingKill ?? controller.attach)?",
      isPresented: Binding(get: { pendingKill != nil }, set: { if !$0 { pendingKill = nil } }),
      titleVisibility: .visible
    ) {
      Button("Kill session", role: .destructive) {
        guard let name = pendingKill else { return }
        pendingKill = nil
        Task { await controller.killSession(name) }
      }
      Button("Cancel", role: .cancel) { pendingKill = nil }
    } message: {
      Text("Everything running in this session stops.")
    }
  }

  private var terminalStack: some View {
    VStack(spacing: 0) {
      header
      ZStack {
        TetherSurfaceRepresentable(
          snapshot: $controller.snapshot,
          sessionKey: controller.sessionKey,
          fontName: preferences.terminalFont.postScriptName,
          fontSize: preferences.terminalFontSize,
          onGridSizeChange: { controller.updateGrid(cols: $0, rows: $1) },
          onGridSizeSettled: { controller.updateGridServer(cols: $0, rows: $1) },
          onScrollLines: { controller.scroll(lines: $0) },
          onTap: { focused = true },
          onSelectionText: { selectionText = $0 },
          onOpenURL: { UIApplication.shared.open($0) },
          onMouseBytes: { controller.sendInput($0) },
          mouseMode: controller.mouseMode,
          mouseSgr: controller.mouseSgr
        )
        .accessibilityIdentifier("sshTerminalSurface")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TetherColors.terminalBackground)
        statusOverlay
        emptyStateOverlay
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      TerminalInputBridge(
        text: $input,
        accessory: AnyView(
          TerminalAccessoryBar(
            model: accessory,
            onKey: { controller.sendInput($0) },
            onPaste: { controller.sendPaste($0) },
            onArrow: { controller.sendInput($0.escapeSequence) },
            onHideKeyboard: { focused = false }
          )
        ),
        showsAccessory: !drawerOpen,
        onSubmitBytes: submit,
        isFocused: $focused
      )
      .frame(height: 1)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(TetherColors.terminalBackground.ignoresSafeArea())
  }

  private var header: some View {
    HStack(spacing: 4) {
      headerButton("line.3.horizontal", id: "sshTerminalDrawer", label: "Open session list") {
        setDrawer(open: true)
      }
      Circle().fill(lampColor).frame(width: lampSize, height: lampSize).padding(.leading, 4)
        .shadow(color: lampColor.opacity(0.55), radius: 4)
        .scaleEffect(controller.status == .connected ? 1 : 1.12)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 0) {
        Text(controller.title).font(.subheadline.weight(.semibold))
          .foregroundStyle(TetherColors.textPrimary)
        HStack(spacing: 4) {
          Text(controller.attach)
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
        Button { Task { await controller.switchSession(to: nextSessionName()) } } label: { Label("New session", systemImage: "plus") }
        Button { showFileImporter = true } label: { Label("Send file…", systemImage: "square.and.arrow.up") }
        Button { showPhotoPicker = true } label: { Label("Send photo…", systemImage: "photo") }
        Button(action: copySelection) { Label("Copy selection", systemImage: "doc.on.doc") }
          .disabled(selectionText?.isEmpty ?? true)
        Button { showHistory = true } label: { Label("Terminal history", systemImage: "clock.arrow.circlepath") }
        Divider()
        Button(role: .destructive) { pendingKill = controller.attach } label: { Label("Kill \(controller.attach)", systemImage: "xmark.circle") }
      } label: {
        Image(systemName: "ellipsis").font(.title3.weight(.semibold))
          .frame(width: tapTarget, height: tapTarget).contentShape(Rectangle())
      }
      .accessibilityIdentifier("sshTerminalOverflow")
      .accessibilityLabel("More terminal actions")
    }
    .foregroundStyle(TetherColors.accent)
    .animation(TetherMotion.ui(TetherMotion.arrive, reduceMotion: reduceMotion), value: controller.status)
    .padding(.horizontal, 10).padding(.vertical, 6)
    .background(TetherColors.surface)
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
    VStack(alignment: .leading, spacing: 0) {
      Text("Sessions").font(.footnote.weight(.semibold))
        .foregroundStyle(TetherColors.textSecondary)
        .padding(.horizontal, 14).padding(.top, 16).padding(.bottom, 8)
        .accessibilityAddTraits(.isHeader)
      ScrollView {
        VStack(spacing: 8) {
          ForEach(controller.sessions) { session in
            sessionRow(session)
          }
          if controller.sessions.isEmpty {
            Text("No sessions yet — name one below to start it.")
              .font(.caption.monospaced()).multilineTextAlignment(.leading)
              .foregroundStyle(TetherColors.textFaint).padding(.top, 12)
          }
          newSessionRow
        }
        .padding(.horizontal, 12)
      }
      Divider().overlay(TetherColors.border)
      Button {
        setDrawer(open: false)
        onHome()
      } label: {
        HStack(spacing: 10) {
          Image(systemName: "house").font(.subheadline.weight(.semibold))
          Text("Home · machines & keys").font(.subheadline.weight(.semibold))
          Spacer()
        }
        .foregroundStyle(TetherColors.accent)
        .padding(.horizontal, 16).padding(.vertical, 16)
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("sshDrawerHome")
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .background(TetherColors.background.ignoresSafeArea())
    .accessibilityIdentifier("sshSessionDrawer")
    .accessibilityAction(.escape) { setDrawer(open: false) }
    .task { await controller.refreshSessions() }
  }

  private func sessionRow(_ session: ZmxSession) -> some View {
    let isCurrent = session.name == controller.attach
    let showsDetail = SessionRowLayout.showsDetail(for: dynamicTypeSize)
    return HStack(spacing: 6) {
      Button {
        Task { await controller.switchSession(to: session.name) }
        setDrawer(open: false)
      } label: {
        HStack(spacing: 10) {
          // The dot repeats what the label already says, so it can go when text
          // needs the room; "attached" is never carried by colour alone.
          Circle().fill(isCurrent ? TetherColors.success : TetherColors.textFaint)
            .frame(width: lampSize, height: lampSize)
          VStack(alignment: .leading, spacing: 2) {
            Text(session.name).font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
            if showsDetail {
              Text(session.displayCwd).font(.caption2.monospaced())
                .foregroundStyle(TetherColors.textFaint).lineLimit(1).truncationMode(.head)
            } else if isCurrent {
              Text("attached").font(.caption2.monospaced()).foregroundStyle(TetherColors.success)
            }
          }
          Spacer(minLength: 4)
          if showsDetail, session.clients > 0 {
            Text("\(session.clients)").font(.caption2.weight(.semibold).monospaced())
              .foregroundStyle(TetherColors.success)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("zmxSession_\(session.name)")
      .accessibilityLabel(sessionAccessibilityLabel(session, isCurrent: isCurrent))
      .accessibilityHint(isCurrent ? "Already attached" : "Attaches this session")
      // A visible control stays: keyboard and VoiceOver users never need the
      // context menu, and a full-swipe kill would destroy work without a prompt.
      Button { pendingKill = session.name } label: {
        Image(systemName: "xmark.circle.fill").font(.body)
          .foregroundStyle(TetherColors.textFaint)
          .frame(width: tapTarget * 0.8, height: tapTarget * 0.8).contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("zmxKill_\(session.name)")
      .accessibilityLabel("Kill session \(session.name)")
      .accessibilityHint("Asks to confirm first")
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(isCurrent ? TetherColors.accent.opacity(0.4) : TetherColors.border))
    .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: isCurrent)
    .contextMenu {
      Button {
        Task { await controller.switchSession(to: session.name) }
        setDrawer(open: false)
      } label: { Label("Open", systemImage: "terminal") }
      Button(role: .destructive) { pendingKill = session.name } label: {
        Label("Kill", systemImage: "xmark.circle")
      }
    }
  }

  private func sessionAccessibilityLabel(_ session: ZmxSession, isCurrent: Bool) -> String {
    var parts = [session.name, isCurrent ? "attached" : "not attached"]
    if SessionRowLayout.showsDetail(for: dynamicTypeSize) {
      parts.append(session.displayCwd)
      if session.clients > 0 { parts.append("\(session.clients) client\(session.clients == 1 ? "" : "s")") }
    }
    return parts.joined(separator: ", ")
  }

  private var newSessionRow: some View {
    HStack(spacing: 8) {
      TextField("new session", text: $newSessionName)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
        .padding(9).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
        .accessibilityIdentifier("sshNewSessionField")
        .accessibilityLabel("New session name")
        .onSubmit(startNewSession)
      Button(action: startNewSession) {
        Image(systemName: "plus").font(.subheadline.weight(.semibold))
          .frame(width: tapTarget * 0.85, height: tapTarget * 0.85)
          .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 10))
          .foregroundStyle(TetherColors.onAccent)
      }
      .buttonStyle(TetherPressStyle())
      .disabled(newSessionName.trimmingCharacters(in: .whitespaces).isEmpty)
      .accessibilityIdentifier("sshNewSessionAdd")
      .accessibilityLabel("Start session")
    }
    .padding(.top, 4)
  }

  private func startNewSession() {
    let name = newSessionName.trimmingCharacters(in: .whitespaces)
    guard !name.isEmpty else { return }
    newSessionName = ""
    Task { await controller.switchSession(to: name) }
    setDrawer(open: false)
  }

  /// Folds a latched Ctrl into typed input so the keyboard can produce Ctrl+C etc.
  private func submit(_ text: String) {
    if accessory.ctrlArmed, let folded = TerminalKeyMap.ctrlFolded(text) {
      accessory.ctrlArmed = false
      controller.sendInput(folded)
      return
    }
    controller.sendInput(text)
  }

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

  private var statusLabel: String {
    switch controller.status {
    case .connecting: "connecting"
    case .connected: "live"
    // A dropped session on a dead path is waiting for the network, not for the
    // host — saying "reconnecting" there would be a lie the user can't act on.
    case .disconnected: (controller.reachability?.isUsable ?? true) ? "reconnecting" : "no network"
    case .failed: "error"
    }
  }

  /// A narrow leading strip, never the terminal itself: selection, scrolling and
  /// mouse mode keep the rest of the surface. The header button and VoiceOver
  /// path stay the primary way in — this is a shortcut, not the only route.
  @ViewBuilder
  private var drawerEdgeGesture: some View {
    if !drawerOpen {
      Color.clear
        .frame(width: DrawerDragDecision.edgeWidth)
        .contentShape(Rectangle())
        .gesture(
          DragGesture(minimumDistance: 12)
            .onEnded { value in
              guard DrawerDragDecision.decide(
                isOpen: false, startX: value.startLocation.x, translation: value.translation
              ) == .open else { return }
              setDrawer(open: true)
            }
        )
        .accessibilityHidden(true)
    }
  }

  /// Local to the drawer panel — it never sees a touch that began on the grid.
  private var drawerCloseDrag: some Gesture {
    DragGesture(minimumDistance: 12)
      .onEnded { value in
        guard DrawerDragDecision.decide(
          isOpen: true, startX: value.startLocation.x, translation: value.translation
        ) == .close else { return }
        setDrawer(open: false)
      }
  }

  private func setDrawer(open: Bool) {
    withAnimation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion)) { drawerOpen = open }
  }

  private func copySelection() {
    guard let text = selectionText, !text.isEmpty else { return }
    UIPasteboard.general.string = text
    acknowledgeCopy()
  }

  private func acknowledgeCopy() {
    copyFeedback += 1
    showCopyConfirmation = true
    Task {
      try? await Task.sleep(for: .seconds(1.2))
      guard !Task.isCancelled else { return }
      showCopyConfirmation = false
    }
  }

  @ViewBuilder
  private var copyConfirmation: some View {
    if showCopyConfirmation {
      Label("Copied", systemImage: "checkmark.circle.fill")
        .font(.caption.weight(.semibold))
        .foregroundStyle(TetherColors.textPrimary)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(TetherColors.surface.opacity(0.96), in: Capsule())
        .overlay(Capsule().strokeBorder(TetherColors.accent.opacity(0.5)))
        .padding(.bottom, 24)
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

  /// One overlay for every not-connected state. The copy comes from the
  /// controller so a network blocker and an SSH failure can never be confused:
  /// a reachable path is never reported as a working connection.
  @ViewBuilder
  private var statusOverlay: some View {
    if let copy = SSHTerminalController.connectionCopy(
      status: controller.status, reachability: controller.reachability
    ) {
      VStack(spacing: 12) {
        if copy.showsRetry {
          Image(systemName: copy.icon).font(.largeTitle).foregroundStyle(TetherColors.danger)
        } else if controller.reachability?.isUsable ?? true {
          ProgressView().tint(TetherColors.accent)
        } else {
          Image(systemName: copy.icon).font(.largeTitle).foregroundStyle(TetherColors.warning)
        }
        Text(copy.message).font(.footnote.monospaced())
          .foregroundStyle(TetherColors.textSecondary).multilineTextAlignment(.center)
        if copy.showsRetry {
          Button("Retry") { Task { await controller.connect() } }
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

  /// Shown over the terminal when connected to a host that has no zmx session:
  /// nothing is auto-created, so the terminal stays gated until the user starts
  /// one from the drawer.
  @ViewBuilder
  private var emptyStateOverlay: some View {
    if case .connected = controller.status, !controller.hasSession {
      VStack(spacing: 14) {
        Image(systemName: "terminal").font(.largeTitle).foregroundStyle(TetherColors.textSecondary)
        Text("No session on \(controller.title)")
          .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
          .multilineTextAlignment(.center)
        Text("Nothing runs until you start one.")
          .font(.caption.monospaced()).foregroundStyle(TetherColors.textFaint)
        Button("New session") {
          withAnimation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion)) { drawerOpen = true }
        }
        .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.onAccent)
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 11))
        .buttonStyle(TetherPressStyle())
        .accessibilityIdentifier("sshEmptyStateNew")
      }
      .padding(24).frame(maxWidth: 300)
      .background(TetherColors.surface.opacity(0.95), in: RoundedRectangle(cornerRadius: 16))
      .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
    }
  }
}
#endif
