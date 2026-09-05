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
      // The backdrop, as the ZStack's FIRST child rather than a .background()
      // modifier. As a modifier it did not reach the home-indicator strip even
      // with ignoresSafeArea, so the window's own darker fill showed through
      // there and read as a band under the key bar. Measured: (11,11,18) under
      // the scrim instead of (20,20,30).
      TetherColors.terminalBackground
        .ignoresSafeArea()

      // Atmospheric bloom — the active session's heat colour, soft and inset so
      // it belongs to the screen rather than washing the whole chrome. The
      // crossfade between heats, and the single swell on entering `waiting`,
      // live in the layer itself.
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
          // Anything that covers the terminal has to take the key bar with it.
          // The bar is an inputAccessoryView, so it lives in the keyboard
          // window ABOVE the app: an in-app overlay cannot hide it, and it sat
          // over the presentation, file viewer, and the viewer's loading/error
          // states, clipping their last lines.
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
    // The terminal is the app's main surface, so the window behind it carries the
    // terminal's colour. Anything the terminal does not cover — the home
    // indicator strip below the key bar — then matches instead of showing as a
    // darker band.
    // The terminal measures the keyboard itself and applies its own bottom
    // inset. This has to sit at the ROOT: applied further in, the parent still
    // got SwiftUI's automatic avoidance and the two insets stacked, collapsing
    // the terminal to a strip at the top.
    .ignoresSafeArea(.keyboard, edges: .bottom)
    .preferredColorScheme(preferences.colorSchemePreference.swiftUIColorScheme)
    .environment(\.litChrome, litChrome)
    // Chained on the ZStack, not hung off zero-size sibling hosts. The hosts
    // were an attempt at the dead … button — SwiftUI keeps one presentation slot
    // per view, so I suspected the sixth modifier was losing it — and they did
    // not fix it; replacing the confirmationDialog with a Menu did. They cost
    // all 21 of the app's AttributeGraph dependency cycles, measured by removing
    // them (21 → 0), so with five presentations left and each verified to open,
    // they are gone.
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

  /// The … menu's items.
  ///
  /// Same actions the confirmation dialog carried, minus the dialog: a Menu
  /// builds these itself when tapped, so there is no flag to set and nothing
  /// that can fail to present.
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
    // Always present, so the menu is never empty — an empty Menu renders as a
    // disabled control, which would read as the same dead button this replaced.
    Button {
      Task { await store.newTerminal() }
    } label: {
      Label("New terminal", systemImage: "plus")
    }
  }

  private func openDrawer() {
    // Opens NOW, refreshes underneath. Waiting on `refreshDrawer()` first meant
    // the panel stayed shut for as long as the slowest host took to answer, and
    // every impatient tap queued another completion that set `drawerOpen = true`
    // — so one of them re-opened the drawer after the user had closed it.
    drawerOpen = true
    store.refreshDrawerInBackground()
  }
}

/// `sheet(item:)` requires Identifiable and String is not, so the host id is
/// wrapped rather than reaching for a bare `isPresented` flag plus a separate
/// optional — which is the version that goes stale.
extension String: @retroactive Identifiable {
  public var id: String { self }
}
