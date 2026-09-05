import SwiftUI
import TetherKit

struct RootView: View {
  @Bindable var store: SessionStore
  @Bindable var preferences: AppPreferences

  @State private var drawerOpen = false
  @State private var showSettings = false
  @State private var showGit = false
  @State private var showPairing = false
  @State private var workspace = WorkspaceController()
  @State private var showRename = false
  @State private var renameText = ""
  @State private var settingsHostId: String?

  private var litChrome: LitChrome {
    let session = store.activeSession
    return LitChrome.resolve(
      status: session?.status,
      activity: session?.activity,
      lastOutputAt: session?.lastOutputAt
    )
  }

  var body: some View {

    ZStack {
      // Backdrop as the ZStack's FIRST child, not a .background(): as a modifier
      // it left the home-indicator strip showing the window's darker fill.
      TetherColors.terminalBackground
        .ignoresSafeArea()

      // Inset so the bloom belongs to the screen; crossfade + waiting-swell live
      // in the layer itself.
      LitBloomLayer(chrome: litChrome)

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
          overflow: { overflowItems }
        )

        PresentationBannerSlot(store: store, workspace: workspace)

        TerminalView(
          store: store,
          preferences: preferences,
          onAddHost: { showPairing = true },
          // The key bar is an inputAccessoryView in the keyboard window ABOVE the
          // app; an in-app overlay can't hide it, so covering views must take it.
          overlayPresented: drawerOpen
            || workspace.activePresentation != nil
            || workspace.fileView != nil
            || workspace.fileError != nil
            || workspace.fileLoading,
          onOpenFile: { path, line, column in
            Task { await workspace.openFile(store: store, path: path, line: line, column: column) }
          }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }

      #if canImport(UIKit)
      WorkspaceChromeView(store: store, workspace: workspace)

      SessionDrawerOverlay(
        isPresented: $drawerOpen,
        store: store,
        onSelectSession: { hostId, sessionId in
          Task {
            await store.selectSession(hostId: hostId, sessionId: sessionId)
          }
        },
        onHostSettings: { hostId in
          settingsHostId = hostId
          showSettings = true
        }
      )
      #endif

    }
    // The terminal applies its own keyboard inset; this must sit at the ROOT or
    // SwiftUI's automatic avoidance stacks a second inset, collapsing it to a strip.
    .ignoresSafeArea(.keyboard, edges: .bottom)
    .preferredColorScheme(preferences.colorSchemePreference.swiftUIColorScheme)
    .environment(\.litChrome, litChrome)
    // Chained on the ZStack, not on zero-size sibling hosts: the hosts cost all
    // 21 AttributeGraph dependency cycles (21 → 0 when removed) and fixed nothing.
    .sheet(isPresented: $showSettings, onDismiss: { settingsHostId = nil }) {
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
      // Force a fresh NavigationPath when opening for a specific host (or not).
      .id(settingsHostId ?? "settings-root")
    }
    .sheet(isPresented: $showGit) {
      GitDrawerView(store: store, onDismiss: { showGit = false })
        .presentationDetents([.large, .medium])
    }
    .sheet(isPresented: $showPairing) {
      NavigationStack {
        PairDeviceView(hostId: UUID().uuidString) { pairId, host, port, _ in
          do {
            try store.createNoiseHost(name: "", host: host, port: port, pairHostId: pairId)
          } catch {
            store.errorMessage = error.localizedDescription
          }
          showPairing = false
        }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { showPairing = false }
          }
        }
      }
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

  // A Menu builds these when tapped, so there's no flag to set and nothing that
  // can fail to present — unlike the confirmationDialog this replaced.
  @ViewBuilder
  private var overflowItems: some View {
    if store.activeSessionId != nil {
      Button {
        renameText = store.activeSession?.name ?? store.activeSessionId ?? ""
        showRename = true
      } label: {
        Label("Rename session", systemImage: "pencil")
      }
      Button {
        workspace.showOpenFileSheet = true
      } label: {
        Label("Open file…", systemImage: "doc.text")
      }
      Button {
        workspace.showFileImporter = true
      } label: {
        Label("Upload file…", systemImage: "arrow.up.doc")
      }
      Button {
        workspace.showPhotosPicker = true
      } label: {
        Label("Upload photo…", systemImage: "photo")
      }
      Divider()
      Button(role: .destructive) {
        if let id = store.activeSessionId {
          Task { await store.killSession(id: id) }
        }
      } label: {
        Label("Kill session", systemImage: "xmark.circle")
      }
      Divider()
    }
    // Always present: an empty Menu renders as a disabled (dead-looking) control.
    Button {
      Task { await store.newTerminal() }
    } label: {
      Label("New terminal", systemImage: "plus")
    }
  }

  private func openDrawer() {
    // Open NOW, refresh underneath: waiting on the refresh let a queued tap
    // re-open the drawer after the user had closed it.
    drawerOpen = true
    store.refreshDrawerInBackground()
  }
}

// `sheet(item:)` requires Identifiable and String is not; the flag-plus-optional
// alternative goes stale.
extension String: @retroactive Identifiable {
  public var id: String { self }
}
