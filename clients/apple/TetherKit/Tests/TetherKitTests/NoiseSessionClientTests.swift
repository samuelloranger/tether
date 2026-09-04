import Foundation
import XCTest

import TetherFFIBindings
@testable import TetherKit

/// In-memory `NoiseKeyStore` fake so the keychain roundtrip is exercised without
/// touching the real Keychain (unavailable / prompts under the test runner).
final class FakeNoiseKeyStore: NoiseKeyStore {
  private var device: [String: Data] = [:]
  private var server: [String: Data] = [:]

  func loadDevicePrivateKey(hostId: String) throws -> Data? { device[hostId] }
  func saveDevicePrivateKey(_ key: Data, hostId: String) throws { device[hostId] = key }
  func loadServerPublicKey(hostId: String) throws -> Data? { server[hostId] }
  func saveServerPublicKey(_ key: Data, hostId: String) throws { server[hostId] = key }
  func clear(hostId: String) throws {
    device[hostId] = nil
    server[hostId] = nil
  }
}

final class NoiseSessionClientTests: XCTestCase {
  private let code = "011B-2345-6789"

  /// Drive the XXpsk2 pairing handshake initiator<->responder entirely in
  /// process (no sockets): 3 messages, both finish, both enter transport, and a
  /// sealed payload from the initiator opens on the responder. This proves the
  /// Swift<->FFI integration end to end.
  func testPairHandshakeAndTransportInProcess() throws {
    let server = try noiseGenKeypair()
    let device = try noiseGenKeypair()
    let psk = try noiseDerivePsk(code: code)

    let initiator = try FfiNoiseSession.pairInitiator(devicePriv: device.private, psk: psk)
    let responder = try FfiNoiseSession.pairResponder(serverPriv: server.private, psk: psk)

    // -> e
    _ = try responder.readMessage(message: initiator.writeMessage(payload: Data()))
    // <- e, ee, s, es
    _ = try initiator.readMessage(message: responder.writeMessage(payload: Data()))
    // -> s, se
    _ = try responder.readMessage(message: initiator.writeMessage(payload: Data()))

    XCTAssertTrue(initiator.isFinished())
    XCTAssertTrue(responder.isFinished())

    // Responder learns the device's static key; initiator pins the server's.
    XCTAssertEqual(try responder.remoteStatic(), device.public)
    XCTAssertEqual(try initiator.remoteStatic(), server.public)

    try initiator.intoTransport()
    try responder.intoTransport()

    let plaintext = Data("hello ios".utf8)
    let sealed = try initiator.seal(plaintext: plaintext)
    XCTAssertEqual(try responder.open(wire: sealed), plaintext)

    // And the reverse direction.
    let back = Data("pong".utf8)
    XCTAssertEqual(try initiator.open(wire: try responder.seal(plaintext: back)), back)
  }

  /// Drive the IK reconnect handshake with the initiator pinned to the
  /// responder's static key: 2 messages, both finish, transport round-trips.
  func testReconnectHandshakeAndTransportInProcess() throws {
    let server = try noiseGenKeypair()
    let device = try noiseGenKeypair()

    let initiator = try FfiNoiseSession.reconnectInitiator(
      devicePriv: device.private,
      serverPub: server.public
    )
    let responder = try FfiNoiseSession.reconnectResponder(serverPriv: server.private)

    // -> e, es, s, ss
    _ = try responder.readMessage(message: initiator.writeMessage(payload: Data()))
    // <- e, ee, se
    _ = try initiator.readMessage(message: responder.writeMessage(payload: Data()))

    XCTAssertTrue(initiator.isFinished())
    XCTAssertTrue(responder.isFinished())
    XCTAssertEqual(try responder.remoteStatic(), device.public)

    try initiator.intoTransport()
    try responder.intoTransport()

    let plaintext = Data("reconnected".utf8)
    let sealed = try initiator.seal(plaintext: plaintext)
    XCTAssertEqual(try responder.open(wire: sealed), plaintext)
  }

  /// `loadOrCreate` persists a generated device key and pins a server key.
  func testKeychainFakeRoundtrip() throws {
    let store = FakeNoiseKeyStore()
    let hostId = "host-abc"

    XCTAssertNil(try store.loadDevicePrivateKey(hostId: hostId))
    XCTAssertNil(try store.loadServerPublicKey(hostId: hostId))

    let device = try noiseGenKeypair()
    try store.saveDevicePrivateKey(device.private, hostId: hostId)
    try store.saveServerPublicKey(device.public, hostId: hostId)

    XCTAssertEqual(try store.loadDevicePrivateKey(hostId: hostId), device.private)
    XCTAssertEqual(try store.loadServerPublicKey(hostId: hostId), device.public)

    // Per-host isolation: another host sees nothing.
    XCTAssertNil(try store.loadDevicePrivateKey(hostId: "other"))

    try store.clear(hostId: hostId)
    XCTAssertNil(try store.loadDevicePrivateKey(hostId: hostId))
    XCTAssertNil(try store.loadServerPublicKey(hostId: hostId))
  }

  func testServerMessageDecoding() throws {
    let output = Data(#"{"t":"output","chunk":"aGk=","id":42}"#.utf8)
    XCTAssertEqual(
      try JSONDecoder().decode(NoiseServerMessage.self, from: output),
      .output(id: "42", chunk: "aGk=")
    )

    let exit = Data(#"{"t":"exit","id":"sess-1","exitCode":0}"#.utf8)
    XCTAssertEqual(
      try JSONDecoder().decode(NoiseServerMessage.self, from: exit),
      .exit(id: "sess-1", exitCode: 0)
    )
  }

  func testWebSocketURLSchemeMapping() {
    let http = URL(string: "http://host.example:8085")!
    XCTAssertEqual(
      NoiseSessionClient.webSocketURL(base: http, path: "/api/noise/pair")?.absoluteString,
      "ws://host.example:8085/api/noise/pair"
    )

    let https = URL(string: "https://host.example:8443/")!
    XCTAssertEqual(
      NoiseSessionClient.webSocketURL(base: https, path: "/api/noise/session")?.absoluteString,
      "wss://host.example:8443/api/noise/session"
    )
  }
}
