import SwiftUI

public struct SessionDrawerView: View {
  @Bindable public var store: SessionStore
  public var onSelectSession: (String, String) -> Void
  public var onHostSettings: (String) -> Void
  public var onClose: () -> Void

  public init(
    store: SessionStore,
    onSelectSession: @escaping (String, String) -> Void,
    onHostSettings: @escaping (String) -> Void,
    onClose: @escaping () -> Void
  ) {
    self.store = store
    self.onSelectSession = onSelectSession
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
                Task { await store.killSession(id: id, hostId: host.id) }
              },
              onRetryHost: {
                Task { await store.refreshHost(hostId: host.id) }
              },
              onNewTerminal: {
                // Closes on the tap, not when the server answers: awaiting
                // `newTerminal` left the drawer sitting open over a terminal
                // that was already being opened behind it.
                onClose()
                Task { await store.newTerminal(hostId: host.id) }
              },
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
  let onNewTerminal: () -> Void
  let onHostSettings: (String) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
          .id(healthKey)
          .transition(.opacity)
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
          // A killed session is gone the moment the server says so, and a new
          // terminal appears the same way. Fading the row, and letting the rest
          // of the list close the gap, keeps the reader's place in a list where
          // every row looks like its neighbours.
          .transition(.opacity)
        }

        // One per host, not one at the bottom of the drawer. A single global
        // button can only mean "on the active host", so reaching a second
        // server took selecting one of its sessions first — impossible when it
        // has none, which is exactly when you want a new terminal.
        NewTerminalRow(hostName: host.name, action: onNewTerminal)
          .disabled(isUnavailable)
      }
      .animation(
        TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion),
        value: sessions.map(\.id)
      )
      .padding(.leading, 12)
      .overlay(alignment: .leading) {
        Rectangle()
          .fill(Color(hex: host.color))
          .frame(width: 3)
      }
    }
    .opacity(isUnavailable ? 0.55 : 1)
    // Keyed coarsely on purpose: `unreachable` carries a failure count that
    // ticks up every poll, and animating on the raw value would re-run the
    // crossfade on a host that has not changed state at all.
    .animation(
      TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion),
      value: healthKey
    )
  }

  private var isUnavailable: Bool { health.isUnavailable }

  private var healthKey: String {
    switch health {
    case .unknown: "unknown"
    case .reachable: "reachable"
    case .unreachable: "unreachable"
    case .unauthorized: "unauthorized"
    }
  }

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
      Button("Pair again", action: onRetryHost)
        .font(.caption.weight(.semibold))
        .foregroundStyle(TetherColors.accent)
    }
  }
}

/// "New terminal" as a list row under one host's sessions.
///
/// Deliberately quieter than a session row — dashed rim, no fill — so it reads
/// as the end of the list rather than as another running terminal.
private struct NewTerminalRow: View {
  let hostName: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: "plus")
          .font(.caption2.weight(.semibold))
        Text("New terminal")
          .font(.footnote)
        Spacer()
      }
      .foregroundStyle(TetherColors.accent)
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(
            TetherColors.accent.opacity(0.35),
            style: StrokeStyle(lineWidth: 1, dash: [4, 3])
          )
      )
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    // The label alone says "New terminal" four times in a four-host drawer, so
    // VoiceOver needs the host to tell them apart.
    .accessibilityLabel("New terminal on \(hostName)")
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
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

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

      // confirmationDialog on these rows never presented (same SwiftUI hole the
      // title-bar overflow used to hit). A Menu presents from the button.
      Menu {
        Button("Kill terminal", role: .destructive, action: onKill)
      } label: {
        Image(systemName: "xmark")
          .foregroundStyle(TetherColors.danger)
          .tapTarget()
      }
      .accessibilityLabel("Kill terminal")
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    // Selection moves between rows: the outgoing row lets go of its fill and
    // rim over the same beat the incoming one takes them on, so the highlight
    // reads as one thing travelling rather than two rows blinking.
    .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: active)
    // A row's own heat follows the chrome's curve, so the drawer and the bloom
    // can never disagree about how fast a session went quiet.
    .animation(TetherMotion.heat(to: rowLit.state, reduceMotion: reduceMotion), value: rowLit)
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


