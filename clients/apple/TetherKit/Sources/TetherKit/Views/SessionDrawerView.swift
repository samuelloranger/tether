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
          .font(.footnote.weight(.semibold))
          .foregroundStyle(TetherColors.textPrimary)
        Spacer()
        Button(action: onClose) {
          Image(systemName: "xmark")
            .tapTarget()
        }
        .accessibilityLabel("Close session list")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(TetherColors.surfaceRaised)

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
      .overlay {
        if store.hosts.isEmpty {
          VStack(spacing: 6) {
            Text("No server yet")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(TetherColors.textPrimary)
            Text("Add one from Settings to open a terminal.")
              .font(.caption)
              .foregroundStyle(TetherColors.textSecondary)
              .multilineTextAlignment(.center)
          }
          .padding(.horizontal, 24)
        }
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
      // With no server paired there is nothing to start a terminal on; the
      // button used to sit there as the primary action and simply fail.
      .disabled(store.hosts.isEmpty)
      .buttonStyle(.borderedProminent)
      .tint(TetherColors.accent)
      .padding(16)
      .background(TetherColors.surfaceRaised)
    }
    .background(TetherColors.background)
    // The drawer is a fixed 264pt wide, so an accessibility text size does not
    // just enlarge it — it truncates every session name. Cap it here.
    .dynamicTypeSize(...DynamicTypeSize.large)
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
        // The host's own colour, which the store has carried all along and the
        // drawer never showed.
        Circle()
          .fill(Color(hex: host.color))
          .frame(width: 8, height: 8)
        // Two servers that never got a custom name are both called by their
        // identity — "Tether" and "Tether" — so the name alone cannot say which
        // machine a session is about to open on. The address can.
        VStack(alignment: .leading, spacing: 1) {
          Text(host.name)
            .font(.caption.weight(.semibold))
            .foregroundStyle(TetherColors.textPrimary)
          Text("\(host.host):\(host.port)")
            .font(.caption2)
            .foregroundStyle(TetherColors.textSecondary)
        }
        statusView
        Spacer()
        Button {
          onHostSettings(host.id)
        } label: {
          Image(systemName: "gearshape")
            .font(.caption)
            .foregroundStyle(TetherColors.textSecondary)
            .tapTarget(36)
        }
        .accessibilityLabel("Server settings for \(host.name) at \(host.host):\(host.port)")
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
    // A plain state is a dot, matching the title bar and the session rows below
    // — three spellings of "reachable" in one panel was one too many. A state
    // you can DO something about keeps its words, because the label is the fix
    // rather than a status.
    case .unknown:
      ProgressView()
        .controlSize(.mini)
        .accessibilityLabel("Connecting")
    case .reachable:
      Circle()
        .fill(TetherColors.success)
        .frame(width: 7, height: 7)
        .accessibilityLabel("Connected")
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

  private var wantsAttention: Bool {
    !active && SessionActivityLogic.dotKey(
      status: status,
      activity: activity,
      live: SessionActivityLogic.isRecentlyActive(lastOutputAt: lastOutputAt)
    ) == .waiting
  }

  private var rowLit: LitChrome {
    LitChrome.resolve(status: status, activity: activity, lastOutputAt: lastOutputAt)
  }

  var body: some View {
    HStack(spacing: 0) {
      Button(action: onSelect) {
        HStack {
          Text(title)
            .font(.footnote)
            .foregroundStyle(active ? rowLit.color : TetherColors.textPrimary)
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
        .background(rowBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(rowBorder, lineWidth: 1)
        )
        .shadow(
          color: active ? rowLit.color.opacity(rowLit.bloom.b2) : .clear,
          radius: active ? 10 : 0,
          y: active ? 4 : 0
        )
      }
      .buttonStyle(.plain)

      Button {
        confirmKill = true
      } label: {
        Image(systemName: "xmark")
          .foregroundStyle(TetherColors.danger)
          .tapTarget()
      }
      .accessibilityLabel("Kill terminal")
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
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

  private var rowBackground: Color {
    if active {
      return rowLit.color.opacity(0.14)
    }
    if wantsAttention {
      return TetherColors.heatWaiting.opacity(0.08)
    }
    return TetherColors.surfaceRaised.opacity(0.55)
  }

  private var rowBorder: Color {
    if active {
      return rowLit.color.opacity(0.35)
    }
    if wantsAttention {
      return TetherColors.heatWaiting.opacity(0.28)
    }
    return TetherColors.border.opacity(0.7)
  }
}


