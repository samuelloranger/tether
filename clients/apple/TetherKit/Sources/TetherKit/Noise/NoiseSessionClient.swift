import Foundation
import TetherFFIBindings

public enum NoiseClientError: Error, LocalizedError {
  case invalidURL
  case notPaired
  case pairingRejected(String)
  case badReply

  public var errorDescription: String? {
    switch self {
    case .invalidURL:
      "Invalid server URL"
    case .notPaired:
      "This host has not been paired yet"
    case let .pairingRejected(reason):
      "Pairing rejected by server: \(reason)"
    case .badReply:
      "Could not decode the server's pairing reply"
    }
  }
}

/// Application messages decoded off an established Noise channel.
///
/// The server sends `{t:"output",chunk,id}` (`id` is the numeric log id) and
/// `{t:"exit",id,exitCode}` (`id` is the session string). `id` is normalised to
/// a String so both shapes decode through one path.
public enum NoiseServerMessage: Sendable, Equatable {
  case output(id: String, chunk: String)
  case exit(id: String, exitCode: Int?)
  /// Reply to `devices.list`: the full roster for this host.
  case devices([DeviceInfo])
  /// Reply to `devices.revoke`: the verdict for one target.
  case devicesRevoked(target: String, ok: Bool, error: String?)
  /// Reply to `auth.token`: an opaque bearer token for REST calls plus its
  /// ISO8601 expiry (`{t:"auth.token",token,expiresAt}`).
  case authToken(token: String, expiresAt: String)
}

/// One paired device as reported by the server over the authenticated Noise
/// session (`{t:"devices"}`). Decodes the server shape verbatim; `lastSeenAt`
/// and `lastAddress` are nullable and `isSelf` flags the device this session is
/// running on.
public struct DeviceInfo: Sendable, Equatable, Decodable, Identifiable {
  public let id: String
  public let label: String
  public let fingerprint: String
  public let pairedAt: String
  public let lastSeenAt: String?
  public let lastAddress: String?
  public let isSelf: Bool

  public init(
    id: String,
    label: String,
    fingerprint: String,
    pairedAt: String,
    lastSeenAt: String?,
    lastAddress: String?,
    isSelf: Bool
  ) {
    self.id = id
    self.label = label
    self.fingerprint = fingerprint
    self.pairedAt = pairedAt
    self.lastSeenAt = lastSeenAt
    self.lastAddress = lastAddress
    self.isSelf = isSelf
  }
}

/// The client engine for Tether's Noise-secured transport. Owns the device
/// keypair / pinned server key (via `NoiseKeyStore`) and drives the two
/// handshakes over a `NoiseTransport`. No SwiftUI here — this is the transport
/// engine the pairing/session UI will sit on top of.
public final class NoiseSessionClient {
  private let keyStore: NoiseKeyStore
  private let session: URLSession

  public init(
    keyStore: NoiseKeyStore = KeychainNoiseKeyStore(),
    session: URLSession = NoiseURLSession.shared
  ) {
    self.keyStore = keyStore
    self.session = session
  }

  // MARK: - Pairing (XXpsk2)

  /// Run the pairing handshake against `<url>/api/noise/pair`, pin the server's
  /// static key, and return it. Loads (or generates and saves) the device
  /// keypair. Three handshake messages flow initiator→responder→initiator, then
  /// the server sends a plaintext `{ok}` verdict and closes.
  @discardableResult
  public func pair(hostId: String, url: URL, code: String) async throws -> Data {
    let psk = try noiseDerivePsk(code: code)
    let devicePriv = try loadOrCreateDeviceKey(hostId: hostId)

    let handshake = try FfiNoiseSession.pairInitiator(devicePriv: devicePriv, psk: psk)
    let transport = try openTransport(url: url, path: "/api/noise/pair")
    defer { Task { await transport.close() } }

    // -> e
    try await transport.send(handshake.writeMessage(payload: Data()))
    // <- e, ee, s, es
    _ = try handshake.readMessage(message: await transport.recv())
    // -> s, se
    try await transport.send(handshake.writeMessage(payload: Data()))

    // Pin the peer static key while still in handshake state (remoteStatic is
    // unavailable once into_transport swaps the inner state).
    let serverPub = try handshake.remoteStatic()
    try keyStore.saveServerPublicKey(serverPub, hostId: hostId)

    // Final verdict is a plaintext JSON frame, not sealed.
    let verdict = try await transport.recv()
    guard let reply = try? JSONDecoder().decode(PairReply.self, from: verdict) else {
      throw NoiseClientError.badReply
    }
    guard reply.ok else {
      throw NoiseClientError.pairingRejected(reply.error ?? "unknown")
    }
    return serverPub
  }

  // MARK: - Reconnect (IK)

  /// Run the IK reconnect handshake against `<url>/api/noise/session` using the
  /// stored device key + pinned server key, and return an established channel in
  /// transport mode for the caller to drive.
  ///
  /// Note: this returns a `NoiseChannel` (the transport-mode `FfiNoiseSession`
  /// bundled with its live socket) rather than a bare `FfiNoiseSession` — the
  /// FFI session alone cannot reach the WebSocket to seal/open over it. The
  /// session is exposed as `channel.session`.
  public func reconnect(hostId: String, url: URL) async throws -> NoiseChannel {
    guard let devicePriv = try keyStore.loadDevicePrivateKey(hostId: hostId) else {
      throw NoiseClientError.notPaired
    }
    guard let serverPub = try keyStore.loadServerPublicKey(hostId: hostId) else {
      throw NoiseClientError.notPaired
    }

    let handshake = try FfiNoiseSession.reconnectInitiator(devicePriv: devicePriv, serverPub: serverPub)
    let transport = try openTransport(url: url, path: "/api/noise/session")

    // -> e, es, s, ss
    try await transport.send(handshake.writeMessage(payload: Data()))
    // <- e, ee, se
    _ = try handshake.readMessage(message: await transport.recv())
    try handshake.intoTransport()

    return NoiseChannel(session: handshake, transport: transport)
  }

  // MARK: - Device auth token

  /// Mint a per-device REST bearer token over a fresh Noise session: reconnect
  /// (IK), send the sealed `{t:"auth.token"}` request, read replies until the
  /// sealed `{t:"auth.token",token,expiresAt}` arrives, close the channel, and
  /// return the token plus its parsed expiry. The channel is closed on every
  /// path (success or throw) — a token request needs no long-lived socket.
  public func requestToken(hostId: String, url: URL) async throws -> (token: String, expiresAt: Date) {
    let channel = try await reconnect(hostId: hostId, url: url)
    do {
      try await channel.sendAuthToken()
      while true {
        let message = try await channel.receive()
        if case let .authToken(token, expiresAt) = message {
          await channel.close()
          guard let date = Self.parseISO8601(expiresAt) else {
            throw NoiseClientError.badReply
          }
          return (token, date)
        }
      }
    } catch {
      await channel.close()
      throw error
    }
  }

  /// Parse a server `expiresAt` (an ISO8601 string, with or without fractional
  /// seconds — `Date().toISOString()` emits milliseconds). Static + internal so
  /// it is unit-testable without a socket.
  static func parseISO8601(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }

  // MARK: - Device fingerprint

  /// The full-form fingerprint of THIS device's own static public key for a
  /// host, or `nil` if no device key is stored under `hostId` yet. The private
  /// key was saved at pairing time; deriving its public key (via the
  /// `noiseDerivePublic` FFI) and fingerprinting it yields the same 64-char
  /// lowercase form the host prints, so the two can be eyeballed side by side.
  public func deviceFingerprintFull(hostId: String) throws -> String? {
    guard let devicePriv = try keyStore.loadDevicePrivateKey(hostId: hostId) else {
      return nil
    }
    let devicePub = try noiseDerivePublic(`private`: devicePriv)
    return NoiseFingerprint.full(devicePub)
  }

  // MARK: - Helpers

  private func loadOrCreateDeviceKey(hostId: String) throws -> Data {
    if let existing = try keyStore.loadDevicePrivateKey(hostId: hostId) {
      return existing
    }
    let keypair = try noiseGenKeypair()
    try keyStore.saveDevicePrivateKey(keypair.private, hostId: hostId)
    return keypair.private
  }

  private func openTransport(url: URL, path: String) throws -> NoiseTransport {
    guard let wsURL = Self.webSocketURL(base: url, path: path) else {
      throw NoiseClientError.invalidURL
    }
    // No Authorization header: the Noise handshake IS the authentication.
    let request = URLRequest(url: wsURL)
    return NoiseTransport(task: session.webSocketTask(with: request))
  }

  /// Build a `ws(s)://host/<path>` URL from an http/https/ws base.
  static func webSocketURL(base: URL, path: String) -> URL? {
    guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
      return nil
    }
    switch components.scheme?.lowercased() {
    case "https", "wss":
      components.scheme = "wss"
    default:
      components.scheme = "ws"
    }
    let basePath = components.path.hasSuffix("/")
      ? String(components.path.dropLast())
      : components.path
    components.path = basePath + (path.hasPrefix("/") ? path : "/" + path)
    return components.url
  }
}

private struct PairReply: Decodable {
  let ok: Bool
  let error: String?
}

/// An established Noise channel: the transport-mode `FfiNoiseSession` plus its
/// live socket. Speaks the sealed terminal application protocol.
public final class NoiseChannel {
  /// The transport-mode FFI session (seal/open/rekey).
  public let session: FfiNoiseSession
  private let transport: NoiseTransport

  init(session: FfiNoiseSession, transport: NoiseTransport) {
    self.session = session
    self.transport = transport
  }

  public func sendStart(
    id: String,
    command: String? = nil,
    cols: UInt16? = nil,
    rows: UInt16? = nil
  ) async throws {
    var obj: [String: Any] = ["t": "start", "id": id]
    if let command { obj["command"] = command }
    if let cols { obj["cols"] = Int(cols) }
    if let rows { obj["rows"] = Int(rows) }
    try await sendSealed(obj)
  }

  public func sendInput(id: String, text: String) async throws {
    try await sendSealed(["t": "input", "id": id, "text": text])
  }

  public func sendResize(id: String, cols: UInt16, rows: UInt16) async throws {
    try await sendSealed(["t": "resize", "id": id, "cols": Int(cols), "rows": Int(rows)])
  }

  public func sendFocus(id: String, focused: Bool) async throws {
    try await sendSealed(Self.focusRequest(id: id, focused: focused))
  }

  /// Ask the host for its full device roster (`{t:"devices.list"}`). The reply
  /// arrives through `receive()` as `.devices`.
  public func sendDevicesList() async throws {
    try await sendSealed(Self.devicesListRequest())
  }

  /// Ask the host to revoke a device by id or fingerprint prefix
  /// (`{t:"devices.revoke",target}`). The verdict arrives through `receive()`
  /// as `.devicesRevoked`.
  public func sendDevicesRevoke(target: String) async throws {
    try await sendSealed(Self.devicesRevokeRequest(target: target))
  }

  /// Ask the host to mint a per-device REST bearer token
  /// (`{t:"auth.token"}`). The reply arrives through `receive()` as
  /// `.authToken`.
  public func sendAuthToken() async throws {
    try await sendSealed(Self.authTokenRequest())
  }

  /// The `devices.list` request body. Pure + static so the wire shape is unit
  /// testable without an established channel.
  static func devicesListRequest() -> [String: Any] {
    ["t": "devices.list"]
  }

  /// The `auth.token` request body. Pure + static, as above.
  static func authTokenRequest() -> [String: Any] {
    ["t": "auth.token"]
  }

  /// The `devices.revoke` request body. Pure + static, as above.
  static func devicesRevokeRequest(target: String) -> [String: Any] {
    ["t": "devices.revoke", "target": target]
  }

  /// The `focus` request body. Pure + static, as above.
  static func focusRequest(id: String, focused: Bool) -> [String: Any] {
    ["t": "focus", "id": id, "focused": focused]
  }

  /// Open the next sealed frame from the server into an application message.
  public func receive() async throws -> NoiseServerMessage {
    let wire = try await transport.recv()
    let plaintext = try session.open(wire: wire)
    return try JSONDecoder().decode(NoiseServerMessage.self, from: plaintext)
  }

  public func close() async {
    await transport.close()
  }

  private func sendSealed(_ obj: [String: Any]) async throws {
    let plaintext = try JSONSerialization.data(withJSONObject: obj)
    let sealed = try session.seal(plaintext: plaintext)
    try await transport.send(sealed)
  }
}

extension NoiseServerMessage: Decodable {
  private enum CodingKeys: String, CodingKey {
    case t, id, chunk, exitCode, items, target, ok, error, token, expiresAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let t = try container.decode(String.self, forKey: .t)
    switch t {
    case "output":
      let chunk = try container.decode(String.self, forKey: .chunk)
      self = .output(id: try Self.decodeId(from: container), chunk: chunk)
    case "exit":
      let exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
      self = .exit(id: try Self.decodeId(from: container), exitCode: exitCode)
    case "devices":
      let items = try container.decode([DeviceInfo].self, forKey: .items)
      self = .devices(items)
    case "devices.revoked":
      let target = try container.decode(String.self, forKey: .target)
      let ok = try container.decode(Bool.self, forKey: .ok)
      let error = try container.decodeIfPresent(String.self, forKey: .error)
      self = .devicesRevoked(target: target, ok: ok, error: error)
    case "auth.token":
      let token = try container.decode(String.self, forKey: .token)
      let expiresAt = try container.decode(String.self, forKey: .expiresAt)
      self = .authToken(token: token, expiresAt: expiresAt)
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .t,
        in: container,
        debugDescription: "Unknown server message type '\(t)'"
      )
    }
  }

  /// `id` is a number for output frames (the log id) and a string for exit
  /// frames (the session id); normalise both to String.
  private static func decodeId(
    from container: KeyedDecodingContainer<CodingKeys>
  ) throws -> String {
    if let intId = try? container.decode(Int.self, forKey: .id) {
      return String(intId)
    }
    return try container.decode(String.self, forKey: .id)
  }
}
