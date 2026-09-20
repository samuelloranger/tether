#if canImport(UIKit)
import SwiftUI
import UIKit

/// An SSH-backed terminal rendered through the shared surface. Chrome is minimal:
/// a title with a Home button and a connection lamp; the grid and key bar are the
/// same components the Noise terminal uses.
public struct SSHTerminalView: View {
  @Bindable var controller: SSHTerminalController
  var onHome: () -> Void

  @State private var input = ""
  @State private var focused = false
  @State private var accessory = TerminalAccessoryModel()
  @State private var showSessions = false
  @Environment(\.scenePhase) private var scenePhase

  public init(controller: SSHTerminalController, onHome: @escaping () -> Void) {
    self.controller = controller
    self.onHome = onHome
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      ZStack {
        TetherSurfaceRepresentable(
          snapshot: $controller.snapshot,
          sessionKey: controller.sessionKey,
          fontName: ".AppleSystemUIFontMonospaced",
          fontSize: 14,
          onGridSizeChange: { controller.updateGrid(cols: $0, rows: $1) },
          onGridSizeSettled: { controller.updateGridServer(cols: $0, rows: $1) },
          onScrollLines: { controller.scroll(lines: $0) },
          onTap: { focused = true },
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
    .task {
      await controller.connect()
      #if DEBUG
      if ProcessInfo.processInfo.environment["TETHER_SSH_DRAWER"] != nil { showSessions = true }
      #endif
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await controller.reconnectIfNeeded() } }
    }
    .sheet(isPresented: $showSessions) {
      ZmxSessionDrawer(controller: controller) { showSessions = false }
        .presentationDetents([.medium, .large])
    }
  }

  private var header: some View {
    HStack(spacing: 10) {
      Button(action: onHome) {
        Image(systemName: "chevron.left").font(.system(size: 15, weight: .semibold))
      }
      .foregroundStyle(TetherColors.accent)
      .accessibilityIdentifier("sshTerminalHome")
      Circle().fill(lampColor).frame(width: 9, height: 9)
      Text(controller.title).font(.system(size: 15, weight: .semibold))
        .foregroundStyle(TetherColors.textPrimary)
      Spacer()
      Button { showSessions = true } label: {
        Image(systemName: "square.stack.3d.up").font(.system(size: 15, weight: .semibold))
      }
      .foregroundStyle(TetherColors.accent)
      .accessibilityIdentifier("sshTerminalSessions")
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .background(TetherColors.surface)
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
        Text("Connecting…").font(.system(size: 13, design: .monospaced))
          .foregroundStyle(TetherColors.textSecondary)
      }
      .padding(20)
      .background(TetherColors.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: 14))
    case let .failed(message):
      VStack(spacing: 12) {
        Image(systemName: "exclamationmark.triangle").font(.system(size: 28))
          .foregroundStyle(TetherColors.danger)
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
