import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

#if os(iOS)
import VisionKit
#endif

/// Pair a device against a tether host over the Noise XXpsk2 handshake. One flow,
/// phases enterCode → scanning → pairing/success/failure over `NoiseSessionClient.pair`.
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
  /// Success callback: the pairing id the keys are stored under, the host + port
  /// (split from the typed address), and the pinned server public key.
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
  /// This device's fingerprint, derived from the stored key once pairing starts.
  /// Nil until `pair()` creates the key, so the waiting screen polls briefly for it.
  @State private var deviceFingerprint: String?

  /// - Parameter hostId: id the device + pinned server keys are stored under —
  ///   a fresh UUID for a new host, or an existing host's id to add this device.
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
  /// Snapshot-only seam: forces a `Phase` and seeds the same `@State` the flow would
  /// reach, without a live server. Derives the real fingerprint from the injected client.
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

  /// `pair()` may create the device key a beat after this screen appears, so poll
  /// briefly for the fingerprint instead of showing "unavailable".
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

  /// User-typed address → base URL. Port implies scheme (`:8443`/`:443` → https,
  /// else http); a bare host defaults to `http://host:8085`. Explicit scheme kept.
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

  /// Split the address into `(host, port)` from the SAME URL `serverURL` builds, so
  /// the stored host matches what was paired. Missing port defaults by scheme.
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

/// 12-cell code field: one transparent `TextField` captures input (paste + auto-uppercase),
/// the visible cells are a non-interactive overlay off `PairingCode.sanitize`d text.
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
/// `DataScannerViewController` wrapped for SwiftUI; reports the first QR payload once
/// via `onCode`. `isAvailable` gates the Scan button (camera missing or denied).
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
