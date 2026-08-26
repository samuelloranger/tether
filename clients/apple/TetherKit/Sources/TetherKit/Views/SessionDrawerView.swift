import SwiftUI

public struct SessionDrawerView: View {
  @Bindable public var store: SessionStore
  public var onSelectSession: (String, String) -> Void
  public var onReenterPassword: (String) -> Void
  public var onHostSettings: (String) -> Void
  public var onClose: () -> Void

  public init(
    store: SessionStore,
    onSelectSession: @escaping (String, String) -> Void,
    onReenterPassword: @escaping (String) -> Void,
    onHostSettings: @escaping (String) -> Void,
    onClose: @escaping () -> Void
  ) {
    self.store = store
    self.onSelectSession = onSelectSession
    self.onReenterPassword = onReenterPassword
    self.onHostSettings = onHostSettings
    self.onClose = onClose
  }

  public var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Sessions")
          .font(.headline)
          .foregroundStyle(TetherColors.textPrimary)
        Spacer()
        Button(action: onClose) {
          Image(systemName: "xmark")
            .frame(width: 32, height: 32)
        }
        .accessibilityLabel("Close session list")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(TetherColors.surface)

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          ForEach(store.hosts) { host in
            HostDrawerSection(
              host: host,
              health: store.healthByHost[host.id] ?? .unknown,
              sessions: sessions(for: host.id),
              activeHostId: store.activeHostId,
              activeSessionId: store.activeSessionId,
              onSelectSession: onSelectSession,
              onKillSession: { id in
                Task { await store.killSession(id: id) }
              },
              onRetryHost: {
                Task { await store.refreshHost(hostId: host.id) }
              },
              onReenterPassword: onReenterPassword,
              onHostSettings: onHostSettings
            )
          }
        }
        .padding(.vertical, 12)
      }

      Button {
        Task {
          await store.newTerminal()
          onClose()
        }
      } label: {
        Label("New terminal", systemImage: "plus")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .tint(TetherColors.accent)
      .padding(16)
      .background(TetherColors.surface)
    }
    .background(TetherColors.background)
  }

  private func sessions(for hostId: String) -> [RemoteSession] {
    let health = store.healthByHost[hostId] ?? .unknown
    if health.isUnavailable { return [] }
    return store.sessionsByHost[hostId] ?? []
  }
}

private struct HostDrawerSection: View {
  let host: HostProfileModel
  let health: HostHealthModel
  let sessions: [RemoteSession]
  let activeHostId: String?
  let activeSessionId: String?
  let onSelectSession: (String, String) -> Void
  let onKillSession: (String) -> Void
  let onRetryHost: () -> Void
  let onReenterPassword: (String) -> Void
  let onHostSettings: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Text(host.name)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(TetherColors.textPrimary)
        statusView
        Spacer()
        Button {
          onHostSettings(host.id)
        } label: {
          Image(systemName: "gearshape")
            .font(.caption)
            .foregroundStyle(TetherColors.textSecondary)
        }
        .accessibilityLabel("Server settings for \(host.name)")
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 8)

      VStack(spacing: 0) {
        ForEach(sessions) { session in
          SessionDrawerRow(
            title: session.displayTitle,
            stopped: !session.isRunning,
            active: host.id == activeHostId && session.id == activeSessionId,
            status: session.status,
            activity: session.activity,
            lastOutputAt: session.lastOutputAt,
            onSelect: { onSelectSession(host.id, session.id) },
            onKill: { onKillSession(session.id) }
          )
        }
      }
      .padding(.leading, 12)
      .overlay(alignment: .leading) {
        Rectangle()
          .fill(Color(hex: host.color))
          .frame(width: 3)
      }
    }
    .opacity(isUnavailable ? 0.55 : 1)
  }

  private var isUnavailable: Bool { health.isUnavailable }

  @ViewBuilder
  private var statusView: some View {
    switch health {
    case .unknown:
      Text("connecting…")
        .font(.caption)
        .foregroundStyle(TetherColors.textSecondary)
    case .reachable:
      Text("online")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.green)
    case .unreachable:
      Button("Retry", action: onRetryHost)
        .font(.caption.weight(.semibold))
        .foregroundStyle(TetherColors.accent)
    case .unauthorized:
      Button("Re-enter password") {
        onReenterPassword(host.id)
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(TetherColors.accent)
    }
  }
}

private struct SessionDrawerRow: View {
  let title: String
  let stopped: Bool
  let active: Bool
  let status: String
  let activity: String?
  let lastOutputAt: String?
  let onSelect: () -> Void
  let onKill: () -> Void
  @State private var confirmKill = false

  var body: some View {
    HStack(spacing: 0) {
      Button(action: onSelect) {
        HStack {
          Text(title)
            .foregroundStyle(active ? TetherColors.accent : TetherColors.textPrimary)
            .lineLimit(1)
          // Which session needs you is the drawer's whole job; without this the
          // rows are indistinguishable.
          SessionActivityBadge(
            status: status,
            activity: activity,
            live: active
              || SessionActivityLogic.isRecentlyActive(lastOutputAt: lastOutputAt)
          )
          if stopped {
            Text("stopped")
              .font(.caption2)
              .foregroundStyle(TetherColors.textSecondary)
          }
          Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(active ? TetherColors.accent.opacity(0.12) : .clear)
      }
      .buttonStyle(.plain)

      Button {
        confirmKill = true
      } label: {
        Image(systemName: "xmark")
          .foregroundStyle(TetherColors.danger)
          .frame(width: 36, height: 36)
      }
      .accessibilityLabel("Kill terminal")
    }
    .confirmationDialog(
      "Kill this terminal?",
      isPresented: $confirmKill,
      titleVisibility: .visible
    ) {
      Button("Kill", role: .destructive, action: onKill)
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("The process and its saved output will be deleted. This can't be undone.")
    }
  }
}


