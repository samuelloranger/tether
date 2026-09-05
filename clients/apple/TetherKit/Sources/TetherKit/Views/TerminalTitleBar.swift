import SwiftUI

public struct TerminalTitleBar<Overflow: View>: View {
  @Bindable public var store: SessionStore
  public var onOpenDrawer: () -> Void
  public var onNewSession: () -> Void
  public var onGit: () -> Void
  public var onSettings: () -> Void
  /// The … menu's items. Presented via `Menu`, not a flag-driven
  /// `confirmationDialog` — that never presented and left a dead spot.
  @ViewBuilder public var overflow: () -> Overflow

  @Environment(\.litChrome) private var lit
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

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

      if lit.state != .none {
        Text(LitTheme.label(for: lit.state))
          .font(.caption2.weight(.semibold))
          .foregroundStyle(lit.color)
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
          .background(lit.color.opacity(0.14), in: Capsule())
          .accessibilityLabel("Session \(LitTheme.label(for: lit.state))")
          // One pill that re-reads rather than three that swap: it fades through
          // instead of cutting, and grows in from the trailing edge on first appear.
          .contentTransition(.opacity)
          .transition(
            reduceMotion
              ? .opacity
              : .opacity.combined(with: .scale(scale: 0.94, anchor: .trailing))
          )
      }

      if let hostId = store.activeHostId {
        ConnectionBadge(status: store.connectionStatus(for: hostId))
      }

      // No spacing: the 44pt targets already sit glyphs 44pt apart; extra gaps
      // pushed the row wide enough to truncate the session title.
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
    .overlay(alignment: .bottom) {
      // Keyed so the two rules crossfade. A hairline is the thinnest thing on
      // screen and the first thing a hard colour cut reads as a glitch on.
      Rectangle()
        .fill(lit.state == .none ? TetherColors.border : lit.color.opacity(max(lit.bloom.rim, 0.25)))
        .frame(height: 1)
        .id(lit.state)
        .transition(.opacity)
    }
    // One animation for the whole bar's heat: the rim and the pill move
    // together, because they are two readings of a single state.
    .animation(TetherMotion.heat(to: lit.state, reduceMotion: reduceMotion), value: lit.state)
  }

  /// An icon on a 44pt target — see `tapTarget()`. The old 32pt frames left a
  /// third of each button dead, worst on the trailing-edge `ellipsis`.
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

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// A dot, not a word: a status label truncated the session title. Colour carries
  /// the state, a spinner marks connecting, and the words survive for VoiceOver.
  var body: some View {
    ZStack {
      if status == .connecting {
        ProgressView()
          .controlSize(.mini)
          .transition(.opacity)
      } else {
        Circle()
          .fill(tint)
          .frame(width: 8, height: 8)
          .overlay(
            Circle().stroke(tint.opacity(0.35), lineWidth: 3).blur(radius: 1)
          )
          // Keyed on status, not just dot-vs-spinner: reconnect-then-drop are
          // distinct events, and a colour that cuts between them looks like a bug.
          .id(status)
          .transition(.opacity)
      }
    }
    .frame(width: 14, height: 14)
    .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: status)
    .accessibilityLabel(label)
  }

  private var label: String {
    switch status {
    case .online: "Connected"
    case .connecting: "Connecting"
    case .offline: "Offline"
    case .authFailed: "Access rejected"
    }
  }

  private var tint: Color {
    switch status {
    case .online: TetherColors.success
    case .connecting: TetherColors.warning
    case .offline: TetherColors.textSecondary
    case .authFailed: TetherColors.danger
    }
  }
}
