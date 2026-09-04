import Foundation
import XCTest

import TetherFFIBindings
@testable import TetherKit

/// Pure-logic coverage for device management: the `DeviceInfo` / `devices` /
/// `devices.revoked` decode, the `devices.list` / `devices.revoke` request
/// encode, and the device self-fingerprint derivation. No sockets, no UI.
final class NoiseDevicesTests: XCTestCase {
  // MARK: - Decode: server → client

  /// `{t:"devices"}` with two rows: one with populated last-seen/address and
  /// `isSelf`, one with null last-seen/address. Both shapes decode.
  func testDevicesMessageDecode() throws {
    let json = Data(#"""
    {
      "t": "devices",
      "items": [
        {
          "id": "dev-1",
          "label": "iPhone 14 Pro",
          "fingerprint": "a1b2 c3d4 e5f6 0718",
          "pairedAt": "2026-01-02T03:04:05Z",
          "lastSeenAt": "2026-09-04T10:00:00Z",
          "lastAddress": "192.168.50.44",
          "isSelf": true
        },
        {
          "id": "dev-2",
          "label": "work laptop",
          "fingerprint": "0f0e 0d0c 0b0a 0908",
          "pairedAt": "2026-02-02T02:02:02Z",
          "lastSeenAt": null,
          "lastAddress": null,
          "isSelf": false
        }
      ]
    }
    """#.utf8)

    let message = try JSONDecoder().decode(NoiseServerMessage.self, from: json)
    guard case let .devices(items) = message else {
      return XCTFail("expected .devices, got \(message)")
    }
    XCTAssertEqual(items.count, 2)

    let first = items[0]
    XCTAssertEqual(first.id, "dev-1")
    XCTAssertEqual(first.label, "iPhone 14 Pro")
    XCTAssertEqual(first.fingerprint, "a1b2 c3d4 e5f6 0718")
    XCTAssertEqual(first.pairedAt, "2026-01-02T03:04:05Z")
    XCTAssertEqual(first.lastSeenAt, "2026-09-04T10:00:00Z")
    XCTAssertEqual(first.lastAddress, "192.168.50.44")
    XCTAssertTrue(first.isSelf)

    let second = items[1]
    XCTAssertEqual(second.id, "dev-2")
    XCTAssertNil(second.lastSeenAt)
    XCTAssertNil(second.lastAddress)
    XCTAssertFalse(second.isSelf)
  }

  /// An empty roster still decodes to `.devices([])`.
  func testDevicesMessageDecodeEmpty() throws {
    let json = Data(#"{"t":"devices","items":[]}"#.utf8)
    let message = try JSONDecoder().decode(NoiseServerMessage.self, from: json)
    XCTAssertEqual(message, .devices([]))
  }

  /// `{t:"devices.revoked"}` decodes both the success and the error shape.
  func testDevicesRevokedDecode() throws {
    let ok = Data(#"{"t":"devices.revoked","target":"dev-2","ok":true}"#.utf8)
    XCTAssertEqual(
      try JSONDecoder().decode(NoiseServerMessage.self, from: ok),
      .devicesRevoked(target: "dev-2", ok: true, error: nil)
    )

    let failed = Data(
      #"{"t":"devices.revoked","target":"nope","ok":false,"error":"not found"}"#.utf8
    )
    XCTAssertEqual(
      try JSONDecoder().decode(NoiseServerMessage.self, from: failed),
      .devicesRevoked(target: "nope", ok: false, error: "not found")
    )
  }

  /// The existing output/exit decode still works after the enum grew.
  func testExistingMessagesStillDecode() throws {
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

  // MARK: - Encode: client → server

  func testDevicesListRequestEncode() throws {
    let data = try JSONSerialization.data(withJSONObject: NoiseChannel.devicesListRequest())
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: String]
    )
    XCTAssertEqual(obj, ["t": "devices.list"])
  }

  func testDevicesRevokeRequestEncode() throws {
    let data = try JSONSerialization.data(
      withJSONObject: NoiseChannel.devicesRevokeRequest(target: "dev-9")
    )
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: String]
    )
    XCTAssertEqual(obj, ["t": "devices.revoke", "target": "dev-9"])
  }

  // MARK: - Self-fingerprint

  /// `deviceFingerprintFull` loads the stored device private key, derives its
  /// public key via the FFI, and fingerprints it — matching the full form of the
  /// keypair's own public key.
  func testDeviceFingerprintFull() throws {
    let store = FakeNoiseKeyStore()
    let hostId = "host-fp"
    let keypair = try noiseGenKeypair()
    try store.saveDevicePrivateKey(keypair.private, hostId: hostId)

    let client = NoiseSessionClient(keyStore: store)
    let fingerprint = try client.deviceFingerprintFull(hostId: hostId)

    XCTAssertEqual(fingerprint, NoiseFingerprint.full(keypair.public))
    // Sanity: the derived public key equals the keypair's own public key.
    XCTAssertEqual(try noiseDerivePublic(`private`: keypair.private), keypair.public)
  }

  /// No stored device key ⇒ nil, not a throw.
  func testDeviceFingerprintFullMissingKey() throws {
    let client = NoiseSessionClient(keyStore: FakeNoiseKeyStore())
    XCTAssertNil(try client.deviceFingerprintFull(hostId: "never-paired"))
  }
}
