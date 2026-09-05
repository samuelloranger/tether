import Foundation
import XCTest

@testable import TetherKit

/// Pure-logic coverage for the `auth.token` device-token exchange: the
/// `{t:"auth.token",token,expiresAt}` decode, the `{t:"auth.token"}` request
/// encode, and the ISO8601 expiry parse. No sockets, no UI.
final class NoiseAuthTokenTests: XCTestCase {
  /// `{t:"auth.token",token,expiresAt}` decodes to `.authToken`.
  func testAuthTokenMessageDecode() throws {
    let json = Data(#"""
    {"t":"auth.token","token":"abc.def","expiresAt":"2026-09-05T10:00:00.000Z"}
    """#.utf8)

    let message = try JSONDecoder().decode(NoiseServerMessage.self, from: json)
    XCTAssertEqual(
      message,
      .authToken(token: "abc.def", expiresAt: "2026-09-05T10:00:00.000Z")
    )
  }

  /// The existing device/output messages still decode after the enum grew.
  func testOtherMessagesStillDecode() throws {
    let output = Data(#"{"t":"output","chunk":"aGk=","id":42}"#.utf8)
    XCTAssertEqual(
      try JSONDecoder().decode(NoiseServerMessage.self, from: output),
      .output(id: "42", chunk: "aGk=")
    )
    let devices = Data(#"{"t":"devices","items":[]}"#.utf8)
    XCTAssertEqual(
      try JSONDecoder().decode(NoiseServerMessage.self, from: devices),
      .devices([])
    )
  }

  /// The `auth.token` request body is exactly `{"t":"auth.token"}`.
  func testAuthTokenRequestEncode() throws {
    let data = try JSONSerialization.data(withJSONObject: NoiseChannel.authTokenRequest())
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
    XCTAssertEqual(obj, ["t": "auth.token"])
  }

  func testFocusRequestShape() throws {
    let data = try JSONSerialization.data(
      withJSONObject: NoiseChannel.focusRequest(id: "sess-1", focused: true)
    )
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(obj["t"] as? String, "focus")
    XCTAssertEqual(obj["id"] as? String, "sess-1")
    XCTAssertEqual(obj["focused"] as? Bool, true)
  }

  /// `expiresAt` parses both with and without fractional seconds
  /// (`Date().toISOString()` emits milliseconds).
  func testParseISO8601() throws {
    let withMillis = try XCTUnwrap(NoiseSessionClient.parseISO8601("2026-09-05T10:00:00.000Z"))
    let withoutMillis = try XCTUnwrap(NoiseSessionClient.parseISO8601("2026-09-05T10:00:00Z"))
    XCTAssertEqual(withMillis.timeIntervalSince1970, withoutMillis.timeIntervalSince1970, accuracy: 0.001)

    XCTAssertNil(NoiseSessionClient.parseISO8601("not-a-date"))
  }
}
