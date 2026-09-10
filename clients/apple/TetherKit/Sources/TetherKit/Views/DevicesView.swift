import SwiftUI

/// Device management for ONE Noise host over a short-lived management session,
/// opened on appear and closed on disappear so no socket/task leaks.
public struct DevicesView: View {
  @State private var model: DevicesModel
  @State private var pendingRevoke: DeviceInfo?
  private let hostName: String
  /// Snapshot seam only: when true the `.task` auto-load is skipped so a preset
  /// phase stays put in a static render. Always false in production.
  private let skipAutoLoad: Bool

  /// - Parameter client: transport engine; the default owns the real Keychain keys
  ///   the host paired with, so `isSelf` and reconnect resolve correctly.
  public init(
    store: SessionStore,
    hostId: String,
    client: NoiseSessionClient = NoiseSessionClient()
  ) {
    let host = store.hosts.first(where: { $0.id == hostId })
    let url = host.flatMap { SessionStore.noiseBaseURL(for: $0) } ?? URL(string: "https://localhost")!
    _model = State(initialValue: DevicesModel(client: client, hostId: hostId, url: url))
    hostName = host?.name ?? "this host"
    skipAutoLoad = false
  }

  #if DEBUG
  /// Snapshot-only seam: hosts a preset `DevicesModel` and skips the auto-load so
  /// the preset phase renders as-is, bypassing store/reconnect wiring.
  init(snapshotModel model: DevicesModel, hostName: String = "homelab") {
    _model = State(initialValue: model)
    self.hostName = hostName
    skipAutoLoad = true
  }
  #endif

  public var body: some View {
    Form {
      switch model.phase {
      case .loading:
        loadingSection
      case let .failed(message):
        errorSection(message)
      case .selfRevoked:
        selfRevokedSection
      case .loaded:
        devicesSection
      }

      if let actionError = model.actionError {
        Section {
          Text(actionError).foregroundStyle(TetherColors.danger)
        }
      }
    }
    .navigationTitle("Devices")
    .navigationBarTitleDisplayMode(.inline)
    .task { if !skipAutoLoad { await model.load() } }
    .onDisappear { model.disconnect() }
    .confirmationDialog(
      pendingRevoke?.isSelf == true ? "Remove this device?" : "Revoke device?",
      isPresented: revokeDialogBinding,
      titleVisibility: .visible,
      presenting: pendingRevoke
    ) { device in
      Button(device.isSelf ? "Remove this device" : "Revoke", role: .destructive) {
        Task { await model.revoke(device) }
      }
      Button("Cancel", role: .cancel) {}
    } message: { device in
      if device.isSelf {
        Text("This will remove THIS device — you'll have to pair again to reconnect.")
      } else {
        Text("\(device.label) will lose access to \(hostName) until it pairs again.")
      }
    }
  }

  // MARK: - Sections

  private var loadingSection: some View {
    Section {
      HStack(spacing: 10) {
        ProgressView().tint(TetherColors.accent)
        Text("Loading devices…").foregroundStyle(TetherColors.textSecondary)
      }
    }
  }

  private func errorSection(_ message: String) -> some View {
    Section {
      Text(message).foregroundStyle(TetherColors.danger)
      Button("Retry") { Task { await model.load() } }
        .buttonStyle(PairingActionStyle(prominent: false))
    } header: {
      Text("Couldn't reach the host").auroraEyebrow()
    }
  }

  private var selfRevokedSection: some View {
    Section {
      VStack(alignment: .leading, spacing: 10) {
        Label("This device was removed", systemImage: "checkmark.circle.fill")
          .foregroundStyle(TetherColors.success)
          .font(.headline)
        Text("Pair again to reconnect to \(hostName).")
          .font(.caption)
          .foregroundStyle(TetherColors.textSecondary)
      }
      .padding(.vertical, 6)
    }
  }

  @ViewBuilder
  private var devicesSection: some View {
    Section {
      ForEach(model.devices) { device in
        deviceRow(device)
      }
    } header: {
      Text("Paired devices").auroraEyebrow()
    } footer: {
      if model.devices.allSatisfy(\.isSelf) {
        Text("No other devices paired.")
          .foregroundStyle(TetherColors.textSecondary)
      }
    }
  }

  private func deviceRow(_ device: DeviceInfo) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Image(systemName: Self.glyph(for: device))
          .foregroundStyle(TetherColors.accent)
          .frame(width: 22)
        Text(device.label)
          .foregroundStyle(TetherColors.textPrimary)
        if device.isSelf {
          Text("This device")
            .auroraEyebrow()
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
              Capsule().fill(TetherColors.accent.opacity(0.16))
            )
        }
        Spacer(minLength: 0)
      }

      Text(Self.shortFingerprint(device.fingerprint))
        .auroraMono()
        .foregroundStyle(TetherColors.textSecondary)

      Text(Self.lastSeenText(device))
        .font(.caption)
        .foregroundStyle(TetherColors.textFaint)

      Button("Revoke", role: .destructive) {
        pendingRevoke = device
      }
      .buttonStyle(PairingActionStyle(prominent: false))
      .tint(TetherColors.danger)
      .disabled(model.revoking)
    }
    .padding(.vertical, 4)
  }

  // MARK: - Presentation helpers

  private var revokeDialogBinding: Binding<Bool> {
    Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } })
  }

  /// A rough platform glyph from the device label — there is no platform field
  /// on the wire, so key off the words a `tether pair` label usually carries.
  static func glyph(for device: DeviceInfo) -> String {
    let label = device.label.lowercased()
    if label.contains("iphone") || label.contains("ios") || label.contains("phone") {
      return "iphone"
    }
    if label.contains("ipad") {
      return "ipad"
    }
    if label.contains("mac") || label.contains("laptop") {
      return "laptopcomputer"
    }
    if label.contains("linux") || label.contains("windows") || label.contains("desktop") {
      return "desktopcomputer"
    }
    return "shield.lefthalf.filled"
  }

  /// The first grouped chunk of the fingerprint — enough to eyeball, short enough
  /// for a row. Keeps the host's grouping (space- or dash-separated) if present.
  static func shortFingerprint(_ fingerprint: String) -> String {
    String(fingerprint.prefix(23))
  }

  static func lastSeenText(_ device: DeviceInfo) -> String {
    guard let lastSeenAt = device.lastSeenAt, !lastSeenAt.isEmpty else {
      return "Never connected"
    }
    if let address = device.lastAddress, !address.isEmpty {
      return "Last seen \(lastSeenAt) · \(address)"
    }
    return "Last seen \(lastSeenAt)"
  }
}

/// Drives one `DevicesView`: owns the management channel and list/revoke state.
/// `@MainActor` for the view; channel opened lazily, torn down on `disconnect()`.
@MainActor
@Observable
final class DevicesModel {
  enum Phase: Equatable {
    case loading
    case loaded
    case selfRevoked
    case failed(String)
  }

  private(set) var phase: Phase = .loading
  private(set) var devices: [DeviceInfo] = []
  private(set) var revoking = false
  var actionError: String?

  private let client: NoiseSessionClient
  private let hostId: String
  private let url: URL
  @ObservationIgnored private var channel: NoiseChannel?

  nonisolated init(client: NoiseSessionClient, hostId: String, url: URL) {
    self.client = client
    self.hostId = hostId
    self.url = url
  }

  #if DEBUG
  /// Snapshot-only seam: a model parked in a given `phase` with a preset roster,
  /// so `DevicesView` renders each state without opening a real channel.
  @MainActor
  convenience init(
    snapshotPhase phase: Phase,
    devices: [DeviceInfo],
    actionError: String? = nil
  ) {
    self.init(
      client: NoiseSessionClient(),
      hostId: "snapshot",
      url: URL(string: "https://snapshot.local")!
    )
    self.phase = phase
    self.devices = devices
    self.actionError = actionError
  }
  #endif

  func load() async {
    phase = .loading
    actionError = nil
    do {
      let channel = try await openChannel()
      try await channel.sendDevicesList()
      devices = try await awaitDevices(on: channel)
      phase = .loaded
    } catch {
      await teardown()
      phase = .failed(error.localizedDescription)
    }
  }

  func revoke(_ device: DeviceInfo) async {
    revoking = true
    actionError = nil
    defer { revoking = false }
    do {
      let channel = try await openChannel()
      try await channel.sendDevicesRevoke(target: device.id)
      let verdict = try await awaitRevoked(on: channel, target: device.id)
      guard verdict.ok else {
        actionError = verdict.error ?? "Revoke failed."
        return
      }
      if device.isSelf {
        // The server tears down the session once this device is gone; there is
        // nothing left to refresh over.
        await teardown()
        devices = []
        phase = .selfRevoked
        return
      }
      try await channel.sendDevicesList()
      devices = try await awaitDevices(on: channel)
    } catch {
      // A seal/send/recv failure may have desynced the Noise cipher — tear the
      // channel down so the next action opens a fresh one instead of reusing it.
      await teardown()
      actionError = error.localizedDescription
    }
  }

  /// Close the management channel. Safe to call repeatedly.
  func disconnect() {
    let channel = channel
    self.channel = nil
    Task { await channel?.close() }
  }

  // MARK: - Channel plumbing

  private func openChannel() async throws -> NoiseChannel {
    if let channel { return channel }
    let channel = try await client.reconnect(hostId: hostId, url: url)
    self.channel = channel
    return channel
  }

  private func teardown() async {
    let channel = channel
    self.channel = nil
    await channel?.close()
  }

  /// Read frames until the roster arrives; loop so an unrelated frame can't
  /// derail the wait.
  private func awaitDevices(on channel: NoiseChannel) async throws -> [DeviceInfo] {
    while true {
      if case let .devices(items) = try await channel.receive() {
        return items
      }
    }
  }

  private func awaitRevoked(
    on channel: NoiseChannel,
    target: String
  ) async throws -> (ok: Bool, error: String?) {
    // Match the verdict to THIS request's target — never consume a verdict meant
    // for another revoke as our own.
    while true {
      if case let .devicesRevoked(verdictTarget, ok, error) = try await channel.receive(),
        verdictTarget == target {
        return (ok, error)
      }
    }
  }
}
