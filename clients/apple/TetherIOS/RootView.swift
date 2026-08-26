import SwiftUI
import TetherKit

struct RootView: View {
  @Bindable var store: SessionStore
  @Bindable var preferences: AppPreferences

  @State private var drawerOpen = false
  @State private var showSettings = false
  @State private var showGit = false
  @State private var showPairing = false
  @State private var showOverflow = false
  @State private var showRename = false
  @State private var renameText = ""
  @State private var settingsHostId: String?
  /// Set when a selected host has no stored password, so the app can ask for
  /// one instead of appearing to do nothing on tap.
  @State private var passwordPromptHostId: String?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        TerminalTitleBar(
          store: store,
          onOpenDrawer: openDrawer,
          onNewSession: {
            Task {
              await store.newTerminal()
            }
          },
          onGit: { showGit = true },
          onSettings: { showSettings = true },
          onOverflow: { showOverflow = true }
        )

        TerminalView(store: store)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }

      #if canImport(UIKit)
      SessionDrawerOverlay(
        isPresented: $drawerOpen,
        store: store,
        onSelectSession: { hostId, sessionId in
          if !store.hasPassword(hostId: hostId) {
            passwordPromptHostId = hostId
            return
          }
          Task {
            await store.selectSession(hostId: hostId, sessionId: sessionId)
          }
        },
        onReenterPassword: { hostId in
          passwordPromptHostId = hostId
        },
        onHostSettings: { hostId in
          settingsHostId = hostId
          showSettings = true
        }
      )
      #endif
    }
    .background(TetherColors.background)
    .preferredColorScheme(preferences.colorSchemePreference.swiftUIColorScheme)
    .sheet(isPresented: $showSettings) {
      ConfigSettingsView(
        store: store,
        preferences: preferences,
        onAddHost: {
          showSettings = false
          showPairing = true
        },
        onDismiss: {
          settingsHostId = nil
          showSettings = false
        },
        initialHostId: settingsHostId
      )
    }
    .sheet(isPresented: $showGit) {
      GitDrawerView(store: store, onDismiss: { showGit = false })
        .presentationDetents([.large, .medium])
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
    .confirmationDialog("Terminal", isPresented: $showOverflow, titleVisibility: .visible) {
      if store.activeSessionId != nil {
        Button("Rename session") {
          renameText = store.activeSession?.name ?? store.activeSessionId ?? ""
          showRename = true
        }
        Button("Kill session", role: .destructive) {
          if let id = store.activeSessionId {
            Task { await store.killSession(id: id) }
          }
        }
      }
      Button("Cancel", role: .cancel) {}
    }
    .alert("Rename session", isPresented: $showRename) {
      TextField("Name", text: $renameText)
      Button("Save") {
        guard let id = store.activeSessionId else { return }
        Task {
          await store.renameSession(id: id, name: renameText)
        }
      }
      Button("Cancel", role: .cancel) {}
    }
  }

  private func openDrawer() {
    Task {
      await store.refreshDrawer()
      drawerOpen = true
    }
  }
}

/// `sheet(item:)` requires Identifiable and String is not, so the host id is
/// wrapped rather than reaching for a bare `isPresented` flag plus a separate
/// optional — which is the version that goes stale.
extension String: @retroactive Identifiable {
  public var id: String { self }
}
