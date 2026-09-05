import SwiftUI

public struct ConfigSettingsView: View {
  @Bindable public var store: SessionStore
  @Bindable public var preferences: AppPreferences
  public var onAddHost: () -> Void
  public var onDismiss: () -> Void
  public var initialHostId: String?
  @State private var path: NavigationPath
  @State private var pairDevice = false
  /// A fresh id the Noise device key + pinned server key are stored under for
  /// this pairing. Regenerated each time the sheet opens so a cancelled attempt
  /// never reuses a half-set-up id.
  @State private var pairHostId = UUID().uuidString

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
    // Seed the stack so a non-nil host id lands on HostSettingsView immediately.
    // onAppear-append is racy with NavigationStack's first layout pass.
    var initial = NavigationPath()
    if let initialHostId {
      initial.append(initialHostId)
    }
    _path = State(initialValue: initial)
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

          Button {
            pairHostId = UUID().uuidString
            pairDevice = true
          } label: {
            Label("Pair a device", systemImage: "lock.shield")
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
      .sheet(isPresented: $pairDevice) {
        NavigationStack {
          PairDeviceView(hostId: pairHostId) { pairId, host, port, scheme, _ in
            // Keys are pinned in the Keychain under `pairId`. Persist a
            // password-less HostProfile for the paired device; `createNoiseHost`
            // migrates the Noise keys onto the profile's real id and selects it.
            do {
              try store.createNoiseHost(
                name: "",
                host: host,
                port: port,
                pairHostId: pairId,
                scheme: scheme
              )
            } catch {
              store.errorMessage = error.localizedDescription
            }
            pairDevice = false
          }
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Cancel") { pairDevice = false }
            }
          }
        }
      }
    }
  }
}

public struct HostSettingsView: View {
  @Bindable public var store: SessionStore
  public let hostId: String
  @State private var nameDraft = ""
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
        Section {
          NavigationLink {
            ServerSettingsView(store: store, hostId: hostId)
          } label: {
            Label("Server settings", systemImage: "server.rack")
          }
          NavigationLink {
            DevicesView(store: store, hostId: hostId)
          } label: {
            Label("Devices", systemImage: "lock.laptopcomputer")
          }
        }

        Section("Name") {
          TextField("Name", text: $nameDraft)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Rename") {
            Task { await store.renameHost(hostId: hostId, name: nameDraft) }
          }
          .disabled(
            nameDraft.trimmingCharacters(in: .whitespaces).isEmpty || nameDraft == host.name
          )
        }

        Section("Connection") {
          LabeledContent("Host", value: host.host)
          LabeledContent("Port", value: host.port)
        }

        Section {
          Button("Remove this host", role: .destructive) {
            confirmRemove = true
          }
        }
      }
    }
    .task { nameDraft = host?.name ?? "" }
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
