import SwiftUI

public struct TerminalTitleBar<Overflow: View>: View {
  @Bindable public var store: SessionStore
  public var onOpenDrawer: () -> Void
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
    onGit: @escaping () -> Void,
    onSettings: @escaping () -> Void,
    @ViewBuilder overflow: @escaping () -> Overflow
  ) {
    self.store = store
    self.onOpenDrawer = onOpenDrawer
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

      // No spacing: the 44pt targets already sit glyphs 44pt apart; extra gaps
      // pushed the row wide enough to truncate the session title.
      HStack(spacing: 0) {
        iconButton("arrow.triangle.branch", label: "Git changes", action: onGit)
          .disabled(store.activeSessionId == nil || store.activeSession?.kind == "agent")
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
