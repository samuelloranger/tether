import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

#if os(iOS)
import VisionKit
#endif

/// Pair a device against a tether host over the Noise XXpsk2 handshake.
///
/// Three visual states in one flow, all Aurora-tokened:
///   1. `enterCode`  — the segmented 12-char code field + host address + Scan QR.
///   2. `scanning`   — VisionKit `DataScannerViewController` reading the code.
///   3. `pairing` / `success` / `failure` — the handshake against the server.
///
/// This sits on top of the proven `NoiseSessionClient.pair(hostId:url:code:)`:
/// it pins the server's static key out of the handshake, the host confirms out
/// of band, and the pinned key comes back for the confirmation screen.
public struct PairDeviceView: View {
  public enum Phase: Equatable {
    case enterCode
    case scanning
    case pairing
    case success
    case failure
  }

  private let client: NoiseSessionClient
  private let hostId: String
  /// Called on success with everything the caller needs to persist a Noise
  /// HostProfile: the pairing id the keys are stored under, the host + port the
  /// user paired against (split out of the typed address), and the pinned server
  /// public key.
  private let onPaired: (
    _ hostId: String,
    _ host: String,
    _ port: String,
    _ pinnedServerKey: Data
  ) -> Void

  @State private var code: String
  @State private var host: String
  @State private var phase: Phase = .enterCode
  @State private var errorMessage: String?
  @State private var pinnedKey: Data?
  /// This device's own full fingerprint, derived from the stored device key once
  /// pairing starts. Nil until the key exists (a brand-new host creates it at the
  /// start of `pair()`), so the waiting screen polls briefly for it.
  @State private var deviceFingerprint: String?

  /// - Parameters:
  ///   - client: the transport engine. Injectable so a fake can drive previews;
  ///     the default owns the real Keychain key store.
  ///   - hostId: the id the device key + pinned server key are stored under. For
  ///     a brand-new host this is a fresh UUID; to add this device to an existing
  ///     host, pass that host's id.
  ///   - initialHost: pre-filled server address (reuse the host you are adding to).
  ///   - onPaired: called on success with the pairing id, the paired host + port,
  ///     and the pinned 32-byte server public key.
  public init(
    client: NoiseSessionClient = NoiseSessionClient(),
    hostId: String,
    initialHost: String = "",
    onPaired: @escaping (
      _ hostId: String,
      _ host: String,
      _ port: String,
      _ pinnedServerKey: Data
    ) -> Void
  ) {
    self.client = client
    self.hostId = hostId
    self.onPaired = onPaired
    _host = State(initialValue: initialHost)
    _code = State(initialValue: "")
  }

  #if DEBUG
  /// Snapshot-only seam. Forces a specific `Phase` (plus optional pre-filled
  /// code/host, a pinned server key, and an error message) so each visual state
  /// renders in a static host snapshot without a live server. This does NOT
  /// change the production initializer above or the real pairing flow — it only
  /// seeds the same `@State` the flow would reach. Snapshot tests only.
  ///
  /// The device fingerprint shown on the `.pairing` screen is derived here, up
  /// front, straight from `client.deviceFingerprintFull(hostId:)` — so injecting
  /// a client whose key store already holds a device key yields the REAL derived
  /// fingerprint rather than the "deriving…" placeholder.
  init(
    snapshotClient client: NoiseSessionClient,
    hostId: String,
    initialHost: String = "",
    initialCode: String = "",
    phase: Phase,
    pinnedKey: Data? = nil,
    errorMessage: String? = nil,
    onPaired: @escaping (
      _ hostId: String,
      _ host: String,
      _ port: String,
      _ pinnedServerKey: Data
    ) -> Void = { _, _, _, _ in }
  ) {
    self.client = client
    self.hostId = hostId
    self.onPaired = onPaired
    _host = State(initialValue: initialHost)
    _code = State(initialValue: initialCode)
    _phase = State(initialValue: phase)
    _pinnedKey = State(initialValue: pinnedKey)
    _errorMessage = State(initialValue: errorMessage)
    _deviceFingerprint = State(initialValue: try? client.deviceFingerprintFull(hostId: hostId))
  }
  #endif

  public var body: some View {
    Form {
      switch phase {
      case .enterCode, .scanning:
        codeSection
        serverSection
        actionSection
      case .pairing:
        waitingSection
      case .success:
        successSection
      case .failure:
        failureSection
      }
    }
    .navigationTitle("Pair a device")
    .listRowSeparatorTint(TetherColors.textSecondary.opacity(0.2))
    #if os(iOS)
    .fullScreenCover(isPresented: scanningBinding) {
      scannerCover
    }
    #endif
  }

  // MARK: - Enter code

  private var codeSection: some View {
    Section {
      CodeEntryField(text: $code)
        .padding(.vertical, 4)
    } header: {
      Text("Pairing code").auroraEyebrow()
    } footer: {
      Text("Read the 12-character code from the host's `tether pair` output.")
        .foregroundStyle(TetherColors.textSecondary)
    }
  }

  private var serverSection: some View {
    Section {
      TextField("Host address", text: $host)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.URL)
        .auroraMono()

      #if os(iOS)
      if DataScannerView.isAvailable {
        Button {
          errorMessage = nil
          phase = .scanning
        } label: {
          Label("Scan QR", systemImage: "qrcode.viewfinder")
        }
        .buttonStyle(PairingActionStyle(prominent: false))
      }
      #endif
    } header: {
      Text("Server").auroraEyebrow()
    }
  }

  private var actionSection: some View {
    Section {
      Button {
        Task { await pair() }
      } label: {
        Text("Pair device")
      }
      .buttonStyle(PairingActionStyle(prominent: true))
      .disabled(!canPair)

      if let errorMessage {
        Text(errorMessage).foregroundStyle(TetherColors.danger)
      }
    }
  }

  private var canPair: Bool {
    PairingCode.isValid(code) && !host.trimmingCharacters(in: .whitespaces).isEmpty
  }

  // MARK: - Waiting

  private var waitingSection: some View {
    Section {
      VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 10) {
          ProgressView()
          Text("Waiting for \(hostLabel) to approve")
            .foregroundStyle(TetherColors.textPrimary)
        }

        VStack(alignment: .leading, spacing: 4) {
          Text("This device").auroraEyebrow()
          if let deviceFingerprint {
            Text(deviceFingerprint)
              .auroraMono()
              .foregroundStyle(TetherColors.textPrimary)
          } else {
            Text("deriving fingerprint…")
              .auroraMono()
              .foregroundStyle(TetherColors.textFaint)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 6)
      .task { await loadDeviceFingerprint() }
    } header: {
      Text("Pairing").auroraEyebrow()
    }
  }

  /// Derive this device's own fingerprint from its stored key. A brand-new host
  /// creates that key at the start of `pair()`, which may land a beat after the
  /// waiting screen appears, so poll briefly rather than showing "unavailable".
  private func loadDeviceFingerprint() async {
    for _ in 0 ..< 40 {
      if let fp = try? client.deviceFingerprintFull(hostId: hostId) {
        deviceFingerprint = fp
        return
      }
      try? await Task.sleep(nanoseconds: 25_000_000)
    }
  }

  // MARK: - Success

  private var successSection: some View {
    Section {
      VStack(alignment: .leading, spacing: 14) {
        Label("Paired with \(hostLabel)", systemImage: "checkmark.circle.fill")
          .foregroundStyle(TetherColors.success)
          .font(.headline)

        if let pinnedKey {
          VStack(alignment: .leading, spacing: 4) {
            Text("Pinned server key").auroraEyebrow()
            Text(NoiseFingerprint.full(pinnedKey))
              .auroraMono()
              .foregroundStyle(TetherColors.textPrimary)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 6)
    }
  }

  // MARK: - Failure

  private var failureSection: some View {
    Section {
      VStack(alignment: .leading, spacing: 14) {
        Label(errorMessage ?? "Pairing failed", systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(TetherColors.danger)

        Button {
          errorMessage = nil
          phase = .enterCode
        } label: {
          Text("Try again")
        }
        .buttonStyle(PairingActionStyle(prominent: true))
      }
      .padding(.vertical, 6)
    }
  }

  // MARK: - Pairing action

  private func pair() async {
    guard let canonical = PairingCode.normalize(code),
          let url = Self.serverURL(from: host) else {
      errorMessage = "Enter a valid code and host address."
      return
    }
    errorMessage = nil
    phase = .pairing
    do {
      let serverKey = try await client.pair(hostId: hostId, url: url, code: canonical)
      HostScheme.record(Self.restScheme(from: url.scheme), forHost: hostId)
      pinnedKey = serverKey
      phase = .success
      let (parsedHost, parsedPort) = Self.hostAndPort(from: host)
        ?? (host.trimmingCharacters(in: .whitespaces), "8085")
      onPaired(hostId, parsedHost, parsedPort, serverKey)
    } catch {
      errorMessage = error.localizedDescription
      phase = .failure
    }
  }

  private var hostLabel: String {
    let trimmed = host.trimmingCharacters(in: .whitespaces)
    return trimmed.isEmpty ? "the host" : trimmed
  }

  /// Map `http`/`https`/`ws`/`wss` to the REST scheme persisted on the host profile.
  static func restScheme(from raw: String?) -> String {
    switch raw?.lowercased() {
    case "https", "wss":
      return "https"
    default:
      return "http"
    }
  }

  /// Turn a user-typed address into a base URL. Port implies scheme when none is
  /// given (`:8085` → http, `:8443`/`:443` → https); a bare host defaults to
  /// `http://host:8085`. An explicit scheme is kept as typed.
  static func serverURL(from raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.contains("://") {
      return URL(string: trimmed)
    }

    var host = trimmed
    var port: String?
    if let colon = trimmed.lastIndex(of: ":") {
      host = String(trimmed[..<colon])
      port = String(trimmed[trimmed.index(after: colon)...])
    }
    guard !host.isEmpty else { return nil }

    let scheme: String
    if let port {
      scheme = port == "443" || port == "8443" ? "https" : "http"
    } else {
      scheme = "http"
    }
    let finalPort = port ?? (scheme == "https" ? "443" : "8085")
    return URL(string: "\(scheme)://\(host):\(finalPort)")
  }

  /// Split the typed address into `(host, port)` for persisting a HostProfile —
  /// derived from the SAME URL `serverURL` builds, so the stored host matches the
  /// endpoint that was actually paired. A missing port defaults from the REST
  /// scheme (`https`/`wss` → 443, `http`/`ws` → 8085). Returns `nil` only when
  /// no host can be parsed.
  static func hostAndPort(from raw: String) -> (host: String, port: String)? {
    guard
      let url = serverURL(from: raw),
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let host = components.host, !host.isEmpty
    else { return nil }
    let scheme = restScheme(from: url.scheme)
    let defaultPort = scheme == "https" ? "443" : "8085"
    let port = components.port.map(String.init) ?? defaultPort
    return (host, port)
  }

  #if os(iOS)
  private var scanningBinding: Binding<Bool> {
    Binding(get: { phase == .scanning }, set: { if !$0, phase == .scanning { phase = .enterCode } })
  }

  @ViewBuilder
  private var scannerCover: some View {
    NavigationStack {
      DataScannerView { payload in
        guard let parsed = PairPayload.parse(payload) else { return }
        code = parsed.code
        if let scannedHost = parsed.host, !scannedHost.isEmpty {
          host = scannedHost
        }
        phase = .enterCode
      }
      .ignoresSafeArea()
      .navigationTitle("Scan pairing code")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { phase = .enterCode }
        }
      }
    }
  }
  #endif
}

// MARK: - Segmented code field

/// A 12-cell code field grouped 4·4·4. A single transparent `TextField` captures
/// input (so system paste and auto-uppercase Just Work); the visible cells are a
/// non-interactive overlay driven off the sanitized text. `PairingCode.sanitize`
/// folds case, dashes, and the ambiguous glyphs and caps at 12, so paste of a
/// whole `7QF4-KM9P-X3TV` lands correctly and out-of-alphabet keystrokes are
/// dropped. The next empty cell carries the accent to show where input goes.
private struct CodeEntryField: View {
  @Binding var text: String
  @FocusState private var focused: Bool

  private var chars: [Character] { Array(text) }

  var body: some View {
    ZStack {
      #if canImport(UIKit)
      TextField("", text: Binding(
        get: { text },
        set: { text = PairingCode.sanitize($0) }
      ))
      .focused($focused)
      .keyboardType(.asciiCapable)
      .textInputAutocapitalization(.characters)
      .autocorrectionDisabled()
      .foregroundStyle(.clear)
      .tint(.clear)
      .accentColor(.clear)
      #else
      TextField("", text: Binding(
        get: { text },
        set: { text = PairingCode.sanitize($0) }
      ))
      .focused($focused)
      .foregroundStyle(.clear)
      #endif

      cells.allowsHitTesting(false)
    }
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
  }

  private var cells: some View {
    HStack(spacing: 8) {
      ForEach(0 ..< 3, content: group)
    }
    .frame(maxWidth: .infinity)
  }

  private func group(_ groupIndex: Int) -> some View {
    HStack(spacing: 6) {
      ForEach(0 ..< 4, id: \.self) { offset in
        cell(at: groupIndex * 4 + offset)
      }
    }
  }

  private func cell(at index: Int) -> some View {
    let char = index < chars.count ? String(chars[index]) : ""
    let isCursor = index == chars.count && focused
    return Text(char.isEmpty ? " " : char)
      .auroraMono(18)
      .foregroundStyle(TetherColors.textPrimary)
      .frame(width: 22, height: 34)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(TetherColors.input)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(
            isCursor ? TetherColors.accent : TetherColors.border,
            lineWidth: isCursor ? 2 : 1
          )
      )
  }
}

// MARK: - QR scanner (iOS 16+ VisionKit)

#if os(iOS)
/// `DataScannerViewController` wrapped for SwiftUI. Reports the first QR payload
/// it reads, once, through `onCode`. Availability is gated by `isAvailable` so
/// the Scan button degrades gracefully where the camera is missing or denied.
struct DataScannerView: UIViewControllerRepresentable {
  let onCode: (String) -> Void

  /// Both must hold: the device supports the scanner (hardware + OS), and the
  /// user has not denied the camera. `isAvailable` reflects the authorization.
  static var isAvailable: Bool {
    DataScannerViewController.isSupported && DataScannerViewController.isAvailable
  }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let controller = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      isHighFrameRateTrackingEnabled: false,
      isHighlightingEnabled: true
    )
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
    try? controller.startScanning()
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(onCode: onCode)
  }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    private let onCode: (String) -> Void
    private var fired = false

    init(onCode: @escaping (String) -> Void) {
      self.onCode = onCode
    }

    func dataScanner(
      _ scanner: DataScannerViewController,
      didAdd addedItems: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      handle(addedItems, scanner)
    }

    func dataScanner(
      _ scanner: DataScannerViewController,
      didTapOn item: RecognizedItem
    ) {
      handle([item], scanner)
    }

    private func handle(_ items: [RecognizedItem], _ scanner: DataScannerViewController) {
      guard !fired else { return }
      for case let .barcode(barcode) in items {
        guard let payload = barcode.payloadStringValue else { continue }
        fired = true
        scanner.stopScanning()
        onCode(payload)
        return
      }
    }
  }
}
#endif
