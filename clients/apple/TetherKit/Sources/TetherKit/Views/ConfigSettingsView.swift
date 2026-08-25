import SwiftUI

public struct ConfigSettingsView: View {
  @Bindable public var store: SessionStore
  @Bindable public var preferences: AppPreferences
  public var onAddHost: () -> Void
  public var onDismiss: () -> Void
  public var initialHostId: String?
  @State private var path = NavigationPath()

  public init(
    store: SessionStore,
    preferences: AppPreferences,
    onAddHost: @escaping () -> Void,
    onDismiss: @escaping () -> Void,
    initialHostId: String? = nil
  ) {
    self.store = store
    self.preferences = preferences
    self.onAddHost = onAddHost
    self.onDismiss = onDismiss
    self.initialHostId = initialHostId
  }

  public var body: some View {
    NavigationStack(path: $path) {
      List {
        Section("Appearance") {
          Picker("Theme", selection: Binding(
            get: { preferences.colorSchemePreference },
            set: { preferences.colorSchemePreference = $0 }
          )) {
            ForEach(AppPreferences.ColorSchemePreference.allCases) { scheme in
              Text(scheme.label).tag(scheme)
            }
          }

          Picker("Terminal font", selection: Binding(
            get: { preferences.terminalFont },
            set: { preferences.terminalFont = $0 }
          )) {
            ForEach(AppPreferences.TerminalFont.allCases) { font in
              Text(font.label).tag(font)
            }
          }

          Stepper(
            value: $preferences.terminalFontSize,
            in: 10 ... 24,
            step: 1
          ) {
            Text("Font size: \(Int(preferences.terminalFontSize)) pt")
          }
        }

        Section("Hosts") {
          ForEach(store.hosts) { host in
            NavigationLink(value: host.id) {
              HStack(spacing: 12) {
                Circle()
                  .fill(Color(hex: host.color))
                  .frame(width: 10, height: 10)
                VStack(alignment: .leading, spacing: 2) {
                  Text(host.name)
                  Text("\(host.host):\(host.port)")
                    .font(.caption)
                    .foregroundStyle(TetherColors.textSecondary)
                }
              }
            }
          }
          .onDelete { indexSet in
            for index in indexSet {
              store.removeHost(id: store.hosts[index].id)
            }
          }

          Button(action: onAddHost) {
            Label("Add host", systemImage: "plus")
          }
        }
      }
      .navigationTitle("Settings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", action: onDismiss)
        }
      }
      .navigationDestination(for: String.self) { hostId in
        HostSettingsView(store: store, hostId: hostId)
      }
      .onAppear {
        if let initialHostId, path.isEmpty {
          path.append(initialHostId)
        }
      }
    }
  }
}

public struct HostSettingsView: View {
  @Bindable public var store: SessionStore
  public let hostId: String
  @State private var password = ""
  @State private var confirmRemove = false

  public init(store: SessionStore, hostId: String) {
    self.store = store
    self.hostId = hostId
  }

  private var host: HostProfileModel? {
    store.hosts.first(where: { $0.id == hostId })
  }

  public var body: some View {
    Form {
      if let host {
        Section("Connection") {
          LabeledContent("Host", value: host.host)
          LabeledContent("Port", value: host.port)
          SecureField("New password", text: $password)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Save password") {
            Task {
              await store.savePassword(password, for: hostId)
              password = ""
            }
          }
          .disabled(password.isEmpty || store.isLoading)
        }

        Section {
          Button("Remove this host", role: .destructive) {
            confirmRemove = true
          }
        }
      }
    }
    .navigationTitle(host?.name ?? "Host")
    .confirmationDialog(
      "Remove this host?",
      isPresented: $confirmRemove,
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        store.removeHost(id: hostId)
      }
      Button("Cancel", role: .cancel) {}
    }
  }
}
