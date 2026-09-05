import SwiftUI

/// Server-side settings (`/api/config` + `/api/admin/*`), ported from
/// `apps/mobile/src/ServerSettings*.tsx`. Client-only prefs stay in
/// `ConfigSettingsView`; this form is pushed per host.
public struct ServerSettingsView: View {
  @Bindable public var store: SessionStore
  public let hostId: String

  @State private var config: ServerConfig?
  @State private var draft: ServerSettingsDraft?
  @State private var version: String?
  @State private var loading = true
  @State private var saving = false
  @State private var message: SettingsMessage?
  @State private var connectionHost = ""
  @State private var connectionPort = ""
  @State private var admin: AdminSheet?
  @State private var confirmTest = false
  @State private var adminBusy = false

  private static let hostColors = [
    "#89b4fa", "#a6e3a1", "#fab387", "#cba6f7", "#f38ba8",
  ]

  public init(store: SessionStore, hostId: String) {
    self.store = store
    self.hostId = hostId
  }

  private var host: HostProfileModel? {
    store.hosts.first(where: { $0.id == hostId })
  }

  private var health: HostHealthModel {
    store.healthByHost[hostId] ?? .unknown
  }

  private var readOnly: Bool {
    health.isUnavailable || draft == nil
  }

  private var dirty: Bool {
    guard let config, let draft else { return false }
    return isServerSettingsDirty(config: config, draft: draft)
  }

  private var validationErrors: [ServerSettingsFieldError: String] {
    guard let draft else { return [:] }
    return validateServerSettingsDraft(draft)
  }

  private var connectionDirty: Bool {
    guard let host else { return false }
    return connectionHost != host.host
      || connectionPort != host.port
  }

  public var body: some View {
    Form {
      connectionSection
      if loading && draft == nil {
        Section {
          ProgressView()
            .tint(TetherColors.accent)
        }
      } else if let draft {
        identitySection(draft)
        notificationsSection(draft)
        sessionsSection(draft)
        statusSection
        maintenanceSection
      } else if let message {
        Section {
          Text(message.text)
            .foregroundStyle(message.kind == .error ? TetherColors.danger : TetherColors.textSecondary)
          Button("Retry") { Task { await reload() } }
        }
      }

      if let message, draft != nil {
        Section {
          Text(message.text)
            .foregroundStyle(message.kind == .error ? TetherColors.danger : TetherColors.textSecondary)
        }
      }

      if draft != nil {
        Section {
          Button(saving ? "Saving…" : dirty ? "Save changes" : "Saved") {
            Task { await saveDraft() }
          }
          .disabled(readOnly || saving || !dirty || !validationErrors.isEmpty)
        }
      }
    }
    .navigationTitle(host?.name ?? "Server")
    .navigationBarTitleDisplayMode(.inline)
    .task { await reload() }
    .sheet(item: $admin) { sheet in
      AdminConfirmSheet(
        operation: sheet,
        busy: adminBusy,
        onCancel: { admin = nil },
        onConfirm: { Task { await runAdmin(sheet) } }
      )
    }
    .confirmationDialog(
      "Send a test notification?",
      isPresented: $confirmTest,
      titleVisibility: .visible
    ) {
      Button("Send") {
        Task { await sendTest() }
      }
      Button("Cancel", role: .cancel) {}
    }
  }

  // MARK: Sections

  private var connectionSection: some View {
    Section("Connection") {
      TextField("Address", text: $connectionHost)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .disabled(saving)
      TextField("Port", text: $connectionPort)
        .keyboardType(.numberPad)
        .disabled(saving)
      if let version {
        LabeledContent("Version", value: version)
          .foregroundStyle(TetherColors.textSecondary)
      }
      Button(connectionDirty ? "Save connection" : "Connection saved") {
        Task { await saveConnection() }
      }
      .disabled(!connectionDirty || saving)
    }
  }

  private func identitySection(_ draft: ServerSettingsDraft) -> some View {
    Section("Name & colour") {
      TextField("Name", text: identityNameBinding(draft))
        .disabled(readOnly)
      if let err = validationErrors[.identityName] {
        Text(err).font(.caption).foregroundStyle(TetherColors.danger)
      }
      Text("Shown on every client and used in notifications.")
        .font(.caption)
        .foregroundStyle(TetherColors.textSecondary)
      // Spacing 0: the 44pt targets already leave 22pt of air between the
      // 22pt swatches. Keeping the old 12pt gap on top of them spread the row
      // out until the colours stopped reading as one control.
      HStack(spacing: 0) {
        ForEach(Self.hostColors, id: \.self) { color in
          Button {
            updateDraft { $0.identity.color = color }
          } label: {
            Circle()
              .fill(Color(hex: color))
              .frame(width: 22, height: 22)
              .overlay {
                if draft.identity.color.lowercased() == color.lowercased() {
                  Circle().strokeBorder(TetherColors.textPrimary, lineWidth: 2)
                }
              }
              // The swatch stays 22pt — a row of 44pt dots would read as
              // buttons rather than as colours — but its target does not.
              .tapTarget()
          }
          .buttonStyle(.plain)
          .disabled(readOnly)
          .accessibilityLabel("Host colour \(color)")
        }
      }
    }
  }

  private func notificationsSection(_ draft: ServerSettingsDraft) -> some View {
    Section("Notifications") {
      Toggle(
        "Push to my devices",
        isOn: Binding(
          get: { draft.push.enabled },
          set: { enabled in updateDraft { $0.push.enabled = enabled } }
        )
      )
      .disabled(readOnly)
      Text(pushStatusHint(enabled: draft.push.enabled, deviceCount: config?.pushDevices ?? 0))
        .font(.caption)
        .foregroundStyle(TetherColors.textSecondary)
      LabeledContent("Registered devices", value: "\(config?.pushDevices ?? 0)")
      Toggle(
        "Agent needs input",
        isOn: Binding(
          get: { draft.triggers.waiting },
          set: { v in updateDraft { $0.triggers.waiting = v } }
        )
      )
      .disabled(readOnly)
      Toggle(
        "Agent finishes a turn",
        isOn: Binding(
          get: { draft.triggers.done },
          set: { v in updateDraft { $0.triggers.done = v } }
        )
      )
      .disabled(readOnly)
      Toggle(
        "Alerts from programs",
        isOn: Binding(
          get: { draft.triggers.oscNotify },
          set: { v in updateDraft { $0.triggers.oscNotify = v } }
        )
      )
      .disabled(readOnly)
      Toggle(
        "Session ends",
        isOn: Binding(
          get: { draft.triggers.exit },
          set: { v in updateDraft { $0.triggers.exit = v } }
        )
      )
      .disabled(readOnly)
      Toggle(
        "Long command finishes",
        isOn: Binding(
          get: { draft.triggers.longJob },
          set: { v in updateDraft { $0.triggers.longJob = v } }
        )
      )
      .disabled(readOnly)
      TextField("Count a command as long after (seconds)", text: longJobBinding(draft))
        .keyboardType(.numberPad)
        .disabled(readOnly)
      if let err = validationErrors[.longJobSeconds] {
        Text(err).font(.caption).foregroundStyle(TetherColors.danger)
      }
      Button("Send test notification") { confirmTest = true }
        .disabled(readOnly || (config?.pushDevices ?? 0) == 0)
    }
  }

  private func sessionsSection(_ draft: ServerSettingsDraft) -> some View {
    Section {
      Text("Changes apply to newly started sessions.")
        .font(.caption)
        .foregroundStyle(TetherColors.textSecondary)
      TextField("Default shell", text: shellBinding(draft))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .disabled(readOnly)
      if let err = validationErrors[.defaultShell] {
        Text(err).font(.caption).foregroundStyle(TetherColors.danger)
      }
      TextField("Default directory", text: cwdBinding(draft))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .disabled(readOnly)
      if let err = validationErrors[.defaultCwd] {
        Text(err).font(.caption).foregroundStyle(TetherColors.danger)
      }
      TextField("Scrollback rows", text: scrollbackBinding(draft))
        .keyboardType(.numberPad)
        .disabled(readOnly)
      if let err = validationErrors[.scrollbackRows] {
        Text(err).font(.caption).foregroundStyle(TetherColors.danger)
      }
      TextField("Mark a session idle after (seconds)", text: silenceBinding(draft))
        .keyboardType(.decimalPad)
        .disabled(readOnly)
      if let err = validationErrors[.silenceMs] {
        Text(err).font(.caption).foregroundStyle(TetherColors.danger)
      }
    } header: {
      Text("Sessions")
    }
  }

  private var statusSection: some View {
    Section("Transport") {
      if let tls = config?.tls ?? draft?.tls {
        LabeledContent("TLS", value: tls.enabled ? "Enabled" : "Off")
        if let port = tls.port {
          LabeledContent("TLS port", value: String(port))
        }
        LabeledContent("Plaintext listener", value: tls.plaintext ? "Open" : "Closed")
        LabeledContent(
          "TLS fingerprint",
          value: tls.fingerprint ?? "—"
        )
        .font(.caption.monospaced())
      } else {
        Text("TLS status unavailable.")
          .foregroundStyle(TetherColors.textSecondary)
      }
    }
  }

  private var maintenanceSection: some View {
    Section {
      Text(
        "Restart and update keep holder-backed sessions alive; they reconnect after the daemon returns."
      )
      .font(.caption)
      .foregroundStyle(TetherColors.textSecondary)
      Button("Check for update", role: .destructive) {
        admin = .update
      }
      Button("Restart server", role: .destructive) {
        admin = .restart
      }
    } header: {
      Text("Maintenance")
    }
  }

  // MARK: Bindings / mutations

  private func updateDraft(_ body: (inout ServerSettingsDraft) -> Void) {
    guard var draft else { return }
    body(&draft)
    self.draft = draft
  }

  private func identityNameBinding(_ draft: ServerSettingsDraft) -> Binding<String> {
    Binding(
      get: { draft.identity.name },
      set: { name in updateDraft { $0.identity.name = name } }
    )
  }

  private func longJobBinding(_ draft: ServerSettingsDraft) -> Binding<String> {
    Binding(
      get: { draft.longJobSeconds },
      set: { v in updateDraft { $0.longJobSeconds = v } }
    )
  }

  private func shellBinding(_ draft: ServerSettingsDraft) -> Binding<String> {
    Binding(
      get: { draft.sessionShell },
      set: { v in updateDraft { $0.sessionShell = v } }
    )
  }

  private func cwdBinding(_ draft: ServerSettingsDraft) -> Binding<String> {
    Binding(
      get: { draft.sessionCwd },
      set: { v in updateDraft { $0.sessionCwd = v } }
    )
  }

  private func scrollbackBinding(_ draft: ServerSettingsDraft) -> Binding<String> {
    Binding(
      get: { draft.scrollbackRows },
      set: { v in updateDraft { $0.scrollbackRows = v } }
    )
  }

  private func silenceBinding(_ draft: ServerSettingsDraft) -> Binding<String> {
    Binding(
      get: { draft.silenceSeconds },
      set: { v in updateDraft { $0.silenceSeconds = v } }
    )
  }

  // MARK: Actions

  private func reload() async {
    loading = true
    message = nil
    if let host {
      connectionHost = host.host
      connectionPort = host.port
    }
    defer { loading = false }
    guard !health.isUnavailable else {
      message = SettingsMessage(kind: .error, text: "Host unreachable. Settings are read-only.")
      return
    }
    async let loaded = store.loadServerConfig(hostId: hostId)
    async let ver = store.loadServerVersion(hostId: hostId)
    version = await ver
    if var next = await loaded {
      // Prefer the local profile name (RN useSettingsLoad hostName overlay).
      if let hostName = host?.name, !hostName.isEmpty {
        next.identity.name = hostName
      }
      config = next
      draft = createServerSettingsDraft(next)
    } else {
      message = SettingsMessage(
        kind: .error,
        text: store.errorMessage ?? "Could not load settings."
      )
    }
  }

  private func saveDraft() async {
    guard let config, let draft else { return }
    saving = true
    message = nil
    defer { saving = false }
    if let next = await store.saveServerConfig(hostId: hostId, config: config, draft: draft) {
      self.config = next
      self.draft = createServerSettingsDraft(next)
      message = SettingsMessage(
        kind: .success,
        text: "Saved. Session defaults apply to newly started sessions."
      )
    } else {
      message = SettingsMessage(
        kind: .error,
        text: store.errorMessage ?? "Could not save settings."
      )
    }
  }

  private func saveConnection() async {
    saving = true
    message = nil
    defer { saving = false }
    let ok = await store.saveHostConnection(
      hostId: hostId,
      host: connectionHost.trimmingCharacters(in: .whitespacesAndNewlines),
      port: connectionPort.trimmingCharacters(in: .whitespacesAndNewlines)
    )
    if ok {
      message = SettingsMessage(kind: .success, text: "Connection saved.")
      await reload()
    } else {
      message = SettingsMessage(
        kind: .error,
        text: store.errorMessage ?? "Could not save the connection."
      )
    }
  }

  private func sendTest() async {
    message = nil
    if await store.sendServerTestNotification(hostId: hostId) {
      message = SettingsMessage(kind: .success, text: "Test notification sent.")
    } else {
      message = SettingsMessage(
        kind: .error,
        text: store.errorMessage ?? "Test notification failed."
      )
    }
  }

  private func runAdmin(_ op: AdminSheet) async {
    adminBusy = true
    message = nil
    defer { adminBusy = false }
    let ok: Bool
    switch op {
    case .update:
      message = SettingsMessage(
        kind: .success,
        text: "Updating… Sessions survive the restart and will reconnect."
      )
      ok = await store.requestServerUpdate(hostId: hostId)
      if ok {
        var actual: String?
        for _ in 0..<10 {
          try? await Task.sleep(nanoseconds: 1_000_000_000)
          actual = await store.loadServerVersion(hostId: hostId)
          if actual != nil { break }
        }
        version = actual
        message = SettingsMessage(
          kind: .success,
          text: actual.map { "Updated. Server is now \($0)." }
            ?? "Update requested; waiting for server reconnect."
        )
      }
    case .restart:
      message = SettingsMessage(
        kind: .success,
        text: "Restarting… Sessions survive and will reconnect."
      )
      ok = await store.requestServerRestart(hostId: hostId)
    }
    if ok {
      admin = nil
    } else if store.errorMessage != nil {
      message = SettingsMessage(
        kind: .error,
        text: store.errorMessage ?? "Server operation failed."
      )
    }
  }
}

// MARK: - Supporting types

private struct SettingsMessage {
  enum Kind {
    case success
    case error
  }

  var kind: Kind
  var text: String
}

private enum AdminSheet: String, Identifiable {
  case update
  case restart

  var id: String { rawValue }

  var title: String {
    switch self {
    case .update: "Update server"
    case .restart: "Restart server"
    }
  }

  var prompt: String {
    switch self {
    case .update: "Update the server to the latest release?"
    case .restart: "Restart the server?"
    }
  }
}

private struct AdminConfirmSheet: View {
  let operation: AdminSheet
  let busy: Bool
  let onCancel: () -> Void
  let onConfirm: () -> Void

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(operation.prompt)
        } footer: {
          Text("Holder-backed sessions survive and reconnect.")
            .foregroundStyle(TetherColors.textSecondary)
        }
      }
      .navigationTitle(operation.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? "Working…" : "Confirm", action: onConfirm)
            .disabled(busy)
        }
      }
    }
    .presentationDetents([.medium])
  }
}
