#if canImport(UIKit)
import SwiftUI
import UIKit

/// The v5 terminal screen: header + slide-over session sidebar + terminal,
/// matching the old layout but backed by SSH + zmx. Home is reached from the
/// bottom of the sidebar.
public struct SSHTerminalView: View {
  @Bindable var controller: SSHTerminalController
  @Bindable var preferences: AppPreferences
  var onHome: () -> Void

  @State private var input = ""
  @State private var focused = false
  @State private var accessory = TerminalAccessoryModel()
  @State private var drawerOpen = false
  @State private var showSettings = false
  @State private var showGit = false
  @State private var newSessionName = ""
  @State private var selectionText: String?
  @State private var confirmKill = false
  @Environment(\.scenePhase) private var scenePhase

  private static let drawerWidth: CGFloat = 280

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
          .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false } }
          .transition(.opacity)
        drawer
          .frame(width: Self.drawerWidth)
          .transition(.move(edge: .leading))
      }
    }
    .task {
      await controller.connect()
      #if DEBUG
      if ProcessInfo.processInfo.environment["TETHER_SSH_DRAWER"] != nil { drawerOpen = true }
      if ProcessInfo.processInfo.environment["TETHER_SSH_GIT"] != nil { showGit = true }
      #endif
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await controller.reconnectIfNeeded() } }
    }
    .sheet(isPresented: $showSettings) { TerminalSettingsSheet(preferences: preferences) { showSettings = false } }
    .sheet(isPresented: $showGit) { GitDiffView(controller: controller) { showGit = false } }
    .confirmationDialog("Kill \(controller.attach)?", isPresented: $confirmKill, titleVisibility: .visible) {
      Button("Kill session", role: .destructive) { Task { await controller.killSession(controller.attach) } }
      Button("Cancel", role: .cancel) {}
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
        statusOverlay
      }
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
        onSubmitBytes: { controller.sendInput($0) },
        isFocused: $focused
      )
      .frame(height: 0)
    }
    .background(TetherColors.terminalBackground.ignoresSafeArea())
  }

  private var header: some View {
    HStack(spacing: 12) {
      Button { withAnimation(.easeOut(duration: 0.2)) { drawerOpen = true } } label: {
        Image(systemName: "line.3.horizontal").font(.system(size: 17, weight: .semibold))
      }
      .accessibilityIdentifier("sshTerminalDrawer")
      Circle().fill(lampColor).frame(width: 9, height: 9)
      VStack(alignment: .leading, spacing: 0) {
        Text(controller.title).font(.system(size: 15, weight: .semibold))
          .foregroundStyle(TetherColors.textPrimary)
        Text(controller.attach).font(.system(size: 10, design: .monospaced))
          .foregroundStyle(TetherColors.textFaint)
      }
      Spacer()
      Button { showGit = true } label: { Image(systemName: "arrow.triangle.branch").font(.system(size: 15, weight: .semibold)) }
        .accessibilityIdentifier("sshTerminalGit")
      Button { showSettings = true } label: { Image(systemName: "gearshape").font(.system(size: 15, weight: .semibold)) }
        .accessibilityIdentifier("sshTerminalSettings")
      Menu {
        Button { Task { await controller.switchSession(to: nextSessionName()) } } label: { Label("New session", systemImage: "plus") }
        Button { if let t = selectionText, !t.isEmpty { UIPasteboard.general.string = t } } label: { Label("Copy selection", systemImage: "doc.on.doc") }
          .disabled(selectionText?.isEmpty ?? true)
        Divider()
        Button(role: .destructive) { confirmKill = true } label: { Label("Kill \(controller.attach)", systemImage: "xmark.circle") }
      } label: {
        Image(systemName: "ellipsis").font(.system(size: 15, weight: .semibold))
      }
      .accessibilityIdentifier("sshTerminalOverflow")
    }
    .foregroundStyle(TetherColors.accent)
    .padding(.horizontal, 14).padding(.vertical, 10)
    .background(TetherColors.surface)
  }

  private var drawer: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Sessions").font(.system(size: 13, weight: .semibold))
        .foregroundStyle(TetherColors.textSecondary)
        .padding(.horizontal, 14).padding(.top, 16).padding(.bottom, 8)
      ScrollView {
        VStack(spacing: 8) {
          ForEach(controller.sessions) { session in
            sessionRow(session)
          }
          if controller.sessions.isEmpty {
            Text("No sessions").font(.system(size: 12, design: .monospaced))
              .foregroundStyle(TetherColors.textFaint).padding(.top, 12)
          }
          newSessionRow
        }
        .padding(.horizontal, 12)
      }
      Divider().overlay(TetherColors.border)
      Button { drawerOpen = false; onHome() } label: {
        HStack(spacing: 10) {
          Image(systemName: "house").font(.system(size: 15, weight: .semibold))
          Text("Home · machines & keys").font(.system(size: 14, weight: .semibold))
          Spacer()
        }
        .foregroundStyle(TetherColors.accent)
        .padding(.horizontal, 16).padding(.vertical, 16)
      }
      .accessibilityIdentifier("sshDrawerHome")
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .background(TetherColors.background.ignoresSafeArea())
    .task { await controller.refreshSessions() }
  }

  private func sessionRow(_ session: ZmxSession) -> some View {
    let isCurrent = session.name == controller.attach
    return Button {
      Task { await controller.switchSession(to: session.name) }
      withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false }
    } label: {
      HStack(spacing: 10) {
        Circle().fill(isCurrent ? TetherColors.success : TetherColors.textFaint).frame(width: 8, height: 8)
        VStack(alignment: .leading, spacing: 2) {
          Text(session.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(TetherColors.textPrimary)
          Text(session.displayCwd).font(.system(size: 10, design: .monospaced))
            .foregroundStyle(TetherColors.textFaint).lineLimit(1).truncationMode(.head)
        }
        Spacer(minLength: 4)
        if session.clients > 0 {
          Text("\(session.clients)").font(.system(size: 9.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(TetherColors.success)
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 10)
      .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(isCurrent ? TetherColors.accent.opacity(0.4) : TetherColors.border))
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button(role: .destructive) { Task { await controller.killSession(session.name) } } label: {
        Label("Kill", systemImage: "xmark.circle")
      }
    }
    .accessibilityIdentifier("zmxSession_\(session.name)")
  }

  private var newSessionRow: some View {
    HStack(spacing: 8) {
      TextField("new session", text: $newSessionName)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .font(.system(size: 12, design: .monospaced)).foregroundStyle(TetherColors.textPrimary)
        .padding(9).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
      Button {
        let name = newSessionName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        newSessionName = ""
        Task { await controller.switchSession(to: name) }
        withAnimation(.easeOut(duration: 0.2)) { drawerOpen = false }
      } label: {
        Image(systemName: "plus").font(.system(size: 14, weight: .semibold))
          .frame(width: 34, height: 34)
          .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 10))
          .foregroundStyle(TetherColors.onAccent)
      }
    }
    .padding(.top, 4)
  }

  private func nextSessionName() -> String {
    var n = controller.sessions.count + 1
    let names = Set(controller.sessions.map(\.name))
    while names.contains("session-\(n)") { n += 1 }
    return "session-\(n)"
  }

  private var lampColor: Color {
    switch controller.status {
    case .connecting: return TetherColors.warning
    case .connected: return TetherColors.success
    case .failed: return TetherColors.danger
    }
  }

  @ViewBuilder
  private var statusOverlay: some View {
    switch controller.status {
    case .connecting:
      VStack(spacing: 10) {
        ProgressView().tint(TetherColors.accent)
        Text("Connecting…").font(.system(size: 13, design: .monospaced)).foregroundStyle(TetherColors.textSecondary)
      }
      .padding(20).background(TetherColors.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: 14))
    case let .failed(message):
      VStack(spacing: 12) {
        Image(systemName: "exclamationmark.triangle").font(.system(size: 28)).foregroundStyle(TetherColors.danger)
        Text(message).font(.system(size: 12, design: .monospaced))
          .foregroundStyle(TetherColors.textSecondary).multilineTextAlignment(.center)
        Button("Retry") { Task { await controller.connect() } }
          .font(.system(size: 14, weight: .semibold)).foregroundStyle(TetherColors.onAccent)
          .padding(.horizontal, 20).padding(.vertical, 10)
          .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 11))
      }
      .padding(24).frame(maxWidth: 300)
      .background(TetherColors.surface.opacity(0.95), in: RoundedRectangle(cornerRadius: 16))
    case .connected:
      EmptyView()
    }
  }
}
#endif
