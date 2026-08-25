import SwiftUI
import TetherKit

struct RootView: View {
  @Bindable var store: SessionStore
  @State private var columnVisibility = NavigationSplitViewVisibility.all
  @State private var showPairing = false

  var body: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      sidebar
    } detail: {
      detail
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
