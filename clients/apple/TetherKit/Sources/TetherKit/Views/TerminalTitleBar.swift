import SwiftUI

public struct TerminalTitleBar: View {
  @Bindable public var store: SessionStore
  public var onOpenDrawer: () -> Void
  public var onNewSession: () -> Void
  public var onGit: () -> Void
  public var onSettings: () -> Void
  public var onOverflow: () -> Void

  public init(
    store: SessionStore,
    onOpenDrawer: @escaping () -> Void,
    onNewSession: @escaping () -> Void,
    onGit: @escaping () -> Void,
    onSettings: @escaping () -> Void,
    onOverflow: @escaping () -> Void
  ) {
    self.store = store
    self.onOpenDrawer = onOpenDrawer
    self.onNewSession = onNewSession
    self.onGit = onGit
    self.onSettings = onSettings
    self.onOverflow = onOverflow
  }

  public var body: some View {
    HStack(spacing: 10) {
      Button(action: onOpenDrawer) {
        Image(systemName: "line.3.horizontal")
          .font(.body.weight(.semibold))
          .frame(width: 36, height: 36)
      }
      .accessibilityLabel("Open session list")

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

      Button(action: onNewSession) {
        Image(systemName: "plus")
          .frame(width: 32, height: 32)
      }
      .accessibilityLabel("New terminal")

      Button(action: onGit) {
        Image(systemName: "arrow.triangle.branch")
          .frame(width: 32, height: 32)
      }
      .accessibilityLabel("Git changes")
      .disabled(store.activeSessionId == nil)

      Button(action: onSettings) {
        Image(systemName: "gearshape")
          .frame(width: 32, height: 32)
      }
      .accessibilityLabel("Settings")

      Button(action: onOverflow) {
        Image(systemName: "ellipsis")
          .frame(width: 32, height: 32)
      }
      .accessibilityLabel("Terminal menu")
    }
    .buttonStyle(.plain)
    .foregroundStyle(TetherColors.textPrimary)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(TetherColors.surface)
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
