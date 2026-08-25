import SwiftUI
import TetherKit

struct RootView: View {
  @Bindable var store: SessionStore
  @State private var columnVisibility = NavigationSplitViewVisibility.all
  @State private var showPairing = false
  /// Set when a selected host has no stored password, so the app can ask for
  /// one instead of appearing to do nothing on tap.
  @State private var passwordPromptHostId: String?

  var body: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      sidebar
    } detail: {
      detail
    }
    .sheet(item: $passwordPromptHostId) { hostId in
      NavigationStack {
        HostPasswordView(
          store: store,
          hostId: hostId,
          hostLabel: store.hosts.first(where: { $0.id == hostId })?.name ?? hostId,
          onDone: { passwordPromptHostId = nil }
        )
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { passwordPromptHostId = nil }
          }
        }
      }
    }
    .sheet(isPresented: $showPairing) {
      NavigationStack {
        PairingView(store: store)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Cancel") { showPairing = false }
            }
          }
      }
    }
  }

  @ViewBuilder
  private var sidebar: some View {
    NavigationStack {
      VStack(spacing: 0) {
        HostListView(store: store, onAddHost: { showPairing = true }) { hostId in
          store.activeHostId = hostId
          // Selecting a host with no credential used to set this id and stop,
          // which read as the tap doing nothing at all.
          if !store.hasPassword(hostId: hostId) {
            passwordPromptHostId = hostId
          }
        }
        Divider()
        SessionListView(store: store) { sessionId in
          Task {
            if let hostId = store.activeHostId {
              await store.selectSession(hostId: hostId, sessionId: sessionId)
            }
          }
        }
      }
      .navigationTitle("Tether")
      .background(TetherColors.background)
    }
  }

  @ViewBuilder
  private var detail: some View {
    if store.activeSessionId != nil {
      TerminalView(store: store)
        .navigationBarTitleDisplayMode(.inline)
    } else {
      ContentUnavailableView(
        "Select a session",
        systemImage: "terminal",
        description: Text("Choose a host and session from the drawer.")
      )
      .background(TetherColors.background)
    }
  }
}

/// `sheet(item:)` requires Identifiable and String is not, so the host id is
/// wrapped rather than reaching for a bare `isPresented` flag plus a separate
/// optional — which is the version that goes stale.
extension String: @retroactive Identifiable {
  public var id: String { self }
}
