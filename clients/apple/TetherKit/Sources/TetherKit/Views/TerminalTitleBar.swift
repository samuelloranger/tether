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
    VStack(spacing: 0) {
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
            // The word changes with the state, so the pill is one element that
            // re-reads rather than three that swap: it fades through instead of
            // cutting, and only grows in from the trailing edge — where it
            // actually sits — when it first appears.
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

      // Desktop status strip, folded into the title bar so it does not fight the
      // utility bar / keyboard for the bottom edge.
      if let session = store.activeSession {
        HStack(spacing: 8) {
          Text(session.id)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(TetherColors.textFaint)
            .lineLimit(1)
          Text("out \(SessionStrip.relativeSince(session.lastOutputAt))")
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(TetherColors.textFaint)
          Text(LitTheme.label(for: lit.state))
            .font(.system(.caption2, design: .monospaced).weight(.semibold))
            .foregroundStyle(lit.color)
            .contentTransition(.opacity)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
          "Session \(session.id), last output \(SessionStrip.relativeSince(session.lastOutputAt)), \(LitTheme.label(for: lit.state))"
        )
      }
    }
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
    // One animation for the whole bar's heat: rim, pill, and the strip's word
    // move together, because they are three readings of a single state.
    .animation(TetherMotion.heat(to: lit.state, reduceMotion: reduceMotion), value: lit.state)
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

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
          // Keyed on the status, not just on dot-vs-spinner: reconnecting and
          // then dropping again are different events, and a colour that cuts
          // between them looks like a render bug rather than a state.
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
    case .authFailed: "Password rejected"
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
