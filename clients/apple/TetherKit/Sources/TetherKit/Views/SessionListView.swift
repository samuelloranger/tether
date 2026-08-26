import SwiftUI

public struct SessionListView: View {
  @Bindable public var store: SessionStore
  public var onOpenSession: (String) -> Void
  @State private var newSessionName = ""
  @State private var renamingSession: RemoteSession?
  @State private var renameText = ""

  public init(store: SessionStore, onOpenSession: @escaping (String) -> Void) {
    self.store = store
    self.onOpenSession = onOpenSession
  }

  public var body: some View {
    List {
      Section {
        HStack {
          TextField("New session name", text: $newSessionName)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Start") {
            let name = newSessionName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return }
            Task {
              await store.startSession(named: name)
              newSessionName = ""
            }
          }
          .disabled(newSessionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }

      Section("Sessions") {
        if store.sessions.isEmpty {
          Text("No sessions on this host")
            .foregroundStyle(TetherColors.textSecondary)
        }
        ForEach(store.sessions) { session in
          let active = store.activeSessionId == session.id
          let live = active || SessionActivityLogic.isRecentlyActive(lastOutputAt: session.lastOutputAt)
          let a11y = SessionActivityLogic.accessibilityLabel(
            title: session.displayTitle,
            status: session.status,
            activity: session.activity,
            live: live
          )
          Button {
            onOpenSession(session.id)
          } label: {
            HStack(spacing: 10) {
              SessionActivityBadge(
                status: session.status,
                activity: session.activity,
                live: live
              )
              VStack(alignment: .leading, spacing: 2) {
                Text(session.displayTitle)
                  .foregroundStyle(TetherColors.textPrimary)
                if !session.isRunning {
                  Text("stopped")
                    .font(.caption)
                    .foregroundStyle(TetherColors.textSecondary)
                }
              }
              Spacer()
              if active {
                Image(systemName: "terminal.fill")
                  .foregroundStyle(TetherColors.accent)
              }
            }
          }
          .accessibilityLabel(a11y)
          .accessibilityAddTraits(active ? .isSelected : [])
          .contextMenu {
            Button("Rename") {
              renamingSession = session
              renameText = session.name ?? session.id
            }
            Button("Kill", role: .destructive) {
              Task { await store.killSession(id: session.id) }
            }
          }
        }
      }
    }
    .refreshable {
      await store.refreshSessions()
    }
    .alert("Rename session", isPresented: Binding(
      get: { renamingSession != nil },
      set: { if !$0 { renamingSession = nil } }
    )) {
      TextField("Name", text: $renameText)
      Button("Save") {
        guard let session = renamingSession else { return }
        Task {
          await store.renameSession(id: session.id, name: renameText)
          renamingSession = nil
        }
      }
      Button("Cancel", role: .cancel) { renamingSession = nil }
    }
  }
}
