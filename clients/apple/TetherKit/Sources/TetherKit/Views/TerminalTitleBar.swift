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
    store.activeSession?.displayTitle ?? "Tether"
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

  var body: some View {
    HStack(spacing: 4) {
      if status == .connecting {
        ProgressView()
          .controlSize(.mini)
      }
      Text(label)
        .font(.caption2.weight(.semibold))
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(background)
    .clipShape(Capsule())
    .accessibilityLabel(label)
  }

  private var label: String {
    switch status {
    case .online: "online"
    case .connecting: "connecting"
    case .offline: "offline"
    case .authFailed: "auth"
    }
  }

  private var background: Color {
    switch status {
    case .online:
      Color.green.opacity(0.18)
    case .connecting:
      Color.orange.opacity(0.18)
    case .offline, .authFailed:
      Color.red.opacity(0.18)
    }
  }
}
