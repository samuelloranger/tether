import SwiftUI

public struct TerminalTitleBar<Overflow: View>: View {
  @Bindable public var store: SessionStore
  public var onOpenDrawer: () -> Void
  public var onNewSession: () -> Void
  public var onGit: () -> Void
  public var onSettings: () -> Void
  /// The … menu's items, supplied by the caller.
  ///
  /// This was a plain action that set a flag for a `confirmationDialog`, and the
  /// dialog never presented — so the button read as a dead spot no amount of
  /// tap-target work could fix. A `Menu` presents itself from the button, with
  /// no presentation state to lose, and an anchored menu is the iOS idiom for an
  /// overflow control anyway.
  @ViewBuilder public var overflow: () -> Overflow

  public init(
    store: SessionStore,
    onOpenDrawer: @escaping () -> Void,
    onNewSession: @escaping () -> Void,
    onGit: @escaping () -> Void,
    onSettings: @escaping () -> Void,
    @ViewBuilder overflow: @escaping () -> Overflow
  ) {
    self.store = store
    self.onOpenDrawer = onOpenDrawer
    self.onNewSession = onNewSession
    self.onGit = onGit
    self.onSettings = onSettings
    self.overflow = overflow
  }

  public var body: some View {
    HStack(spacing: 8) {
      iconButton("line.3.horizontal", label: "Open session list", action: onOpenDrawer)

      VStack(alignment: .leading, spacing: 2) {
        Text(sessionTitle)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(TetherColors.textPrimary)
          .lineLimit(1)
        Text(subtitle)
          .font(.caption)
          .foregroundStyle(TetherColors.textSecondary)
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if let hostId = store.activeHostId {
        ConnectionBadge(status: store.connectionStatus(for: hostId))
      }

      // No spacing inside the cluster: the 44pt targets already sit their glyphs
      // 44pt apart, and adding gaps on top pushed the row wide enough to
      // truncate the session title — the one thing in the bar that carries
      // information.
      HStack(spacing: 0) {
        iconButton("plus", label: "New terminal", action: onNewSession)
        iconButton("arrow.triangle.branch", label: "Git changes", action: onGit)
          .disabled(store.activeSessionId == nil)
        iconButton("gearshape", label: "Settings", action: onSettings)
        Menu {
          overflow()
        } label: {
          Image(systemName: "ellipsis")
            .font(.body.weight(.semibold))
            .tapTarget()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Terminal menu")
      }
    }
    .foregroundStyle(TetherColors.textPrimary)
    .padding(.horizontal, 4)
    .padding(.vertical, 4)
    .background(TetherColors.surface)
  }

  /// An icon on a 44pt target — see `tapTarget()`. These were 32pt frames (36
  /// for the drawer), so a third of each button's area was dead. `ellipsis` was
  /// the worst of them: it sits at the trailing edge, where a thumb naturally
  /// lands slightly outside the frame, and its glyph is a thin horizontal strip
  /// that gives no clue where the target ends.
  private func iconButton(
    _ systemName: String,
    label: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.body.weight(.semibold))
        .tapTarget()
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  private var sessionTitle: String {
    store.activeSession?.displayTitle ?? store.lastKnownSessionTitle ?? "Tether"
  }

  private var subtitle: String {
    if let host = store.activeHost {
      return "\(host.host):\(host.port)"
    }
    // "Select a session" told the reader to do something impossible when no
    // server was paired at all.
    return store.hosts.isEmpty ? "No server paired" : "Select a session"
  }
}

private struct ConnectionBadge: View {
  let status: SessionStore.ConnectionStatus

  /// A dot, not a word.
  ///
  /// The label ("online" / "offline" / "connecting") cost roughly a fifth of the
  /// bar's width and pushed the session title into truncation, and the title is
  /// the thing the reader actually needs — you can only be looking at one
  /// session, and its name tells you which. Colour carries the state at a
  /// glance; a spinner replaces the dot while connecting, because "in progress"
  /// is the one state a static colour cannot express. The words survive for
  /// VoiceOver, which is where they were doing real work.
  var body: some View {
    Group {
      if status == .connecting {
        ProgressView()
          .controlSize(.mini)
      } else {
        Circle()
          .fill(tint)
          .frame(width: 8, height: 8)
          .overlay(
            Circle().stroke(tint.opacity(0.35), lineWidth: 3).blur(radius: 1)
          )
      }
    }
    .frame(width: 14, height: 14)
    .accessibilityLabel(label)
  }

  private var label: String {
    switch status {
    case .online: "Connected"
    case .connecting: "Connecting"
    case .offline: "Offline"
    case .authFailed: "Password rejected"
    }
  }

  private var tint: Color {
    switch status {
    case .online: TetherColors.success
    case .connecting: Color.orange
    case .offline: TetherColors.textSecondary
    case .authFailed: TetherColors.danger
    }
  }
}
