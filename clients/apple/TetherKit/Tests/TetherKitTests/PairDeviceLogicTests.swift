import Foundation
import XCTest

@testable import TetherKit

/// Pure-logic tests for the Pair-a-device flow: Crockford code
/// normalization/grouping/validation (must agree with
/// `crates/tether-core/src/noise/code.rs`, since the core derives the PSK), QR
/// payload parsing, the server-address helper, and the key fingerprint.
final class PairDeviceLogicTests: XCTestCase {
  // MARK: - PairingCode.normalize (mirror of code::normalize)

  func testNormalizeFoldsCaseDashesSpacesAndAmbiguousChars() {
    // o->0, l->1, i->1, b->B — the exact core fixture.
    XCTAssertEqual(PairingCode.normalize("olib-2345-6789"), "011B23456789")
    XCTAssertEqual(PairingCode.normalize("7qf4 km9p x3tv"), "7QF4KM9PX3TV")
    XCTAssertEqual(PairingCode.normalize("011B-2345-6789"), "011B23456789")
  }

  func testNormalizeRejectsWrongLength() {
    XCTAssertNil(PairingCode.normalize("ABC"))
    XCTAssertNil(PairingCode.normalize("011B23456789A")) // 13
    XCTAssertNil(PairingCode.normalize(""))
  }

  func testNormalizeRejectsOutOfAlphabet() {
    // 'U' is excluded from the alphabet and has no fold; '!' is not foldable.
    XCTAssertNil(PairingCode.normalize("U23456789ABC"))
    XCTAssertNil(PairingCode.normalize("!23456789ABC"))
  }

  func testIsValidMatchesNormalize() {
    XCTAssertTrue(PairingCode.isValid("7QF4-KM9P-X3TV"))
    XCTAssertFalse(PairingCode.isValid("7QF4-KM9P-X3T")) // 11 chars
    XCTAssertFalse(PairingCode.isValid("7QF4-KM9P-X3TU")) // contains U
  }

  // MARK: - PairingCode.sanitize (lenient input filter)

  func testSanitizeDropsInvalidAndCapsAtTwelve() {
    XCTAssertEqual(PairingCode.sanitize("7qf4-km9p-x3tv"), "7QF4KM9PX3TV")
    // U dropped, then caps at 12.
    XCTAssertEqual(PairingCode.sanitize("7QF4KM9PX3TVEXTRA"), "7QF4KM9PX3TV")
    // Ambiguous chars folded, junk dropped.
    XCTAssertEqual(PairingCode.sanitize("oli!b"), "011B")
    XCTAssertEqual(PairingCode.sanitize(""), "")
  }

  // MARK: - PairingCode.group / formatted (mirror of code::grouped)

  func testGroupInsertsTwoDashes() {
    XCTAssertEqual(PairingCode.group("011B23456789"), "011B-2345-6789")
  }

  func testGroupHandlesPartialInput() {
    XCTAssertEqual(PairingCode.group("7QF4KM9"), "7QF4-KM9")
    XCTAssertEqual(PairingCode.group("7QF"), "7QF")
    XCTAssertEqual(PairingCode.group(""), "")
  }

  func testFormattedReturnsCanonicalOrNil() {
    XCTAssertEqual(PairingCode.formatted("7qf4km9px3tv"), "7QF4-KM9P-X3TV")
    XCTAssertNil(PairingCode.formatted("nope"))
  }

  // MARK: - PairPayload.parse

  func testParseBareCode() {
    XCTAssertEqual(
      PairPayload.parse("7QF4-KM9P-X3TV"),
      PairPayload(code: "7QF4KM9PX3TV", host: nil)
    )
    // Dashless and lowercase both accepted.
    XCTAssertEqual(
      PairPayload.parse("7qf4km9px3tv"),
      PairPayload(code: "7QF4KM9PX3TV", host: nil)
    )
  }

  func testParseDeepLinkWithHost() {
    let parsed = PairPayload.parse("tether://pair?code=7QF4-KM9P-X3TV&host=https://box:8085")
    XCTAssertEqual(parsed, PairPayload(code: "7QF4KM9PX3TV", host: "https://box:8085"))
  }

  func testParseDeepLinkWithoutHost() {
    XCTAssertEqual(
      PairPayload.parse("tether://pair?code=7QF4KM9PX3TV"),
      PairPayload(code: "7QF4KM9PX3TV", host: nil)
    )
  }

  func testParseRejectsGarbageAndBadCodes() {
    XCTAssertNil(PairPayload.parse(""))
    XCTAssertNil(PairPayload.parse("   "))
    XCTAssertNil(PairPayload.parse("https://example.com"))
    XCTAssertNil(PairPayload.parse("tether://pair?code=SHORT"))
    XCTAssertNil(PairPayload.parse("tether://pair?nope=1"))
  }

  // MARK: - serverURL helper

  func testServerURLBareHostPort8085IsHTTP() {
    XCTAssertEqual(
      PairDeviceView.serverURL(from: "192.168.1.9:8085")?.absoluteString,
      "http://192.168.1.9:8085"
    )
  }

  func testServerURLBareHostNoPortIs8085HTTP() {
    XCTAssertEqual(
      PairDeviceView.serverURL(from: "box")?.absoluteString,
      "http://box:8085"
    )
  }

  func testServerURLPort8443IsHTTPS() {
    XCTAssertEqual(
      PairDeviceView.serverURL(from: "box:8443")?.absoluteString,
      "https://box:8443"
    )
  }

  func testServerURLHTTPSWithoutPortIs443() {
    let url = PairDeviceView.serverURL(from: "https://box")
    XCTAssertEqual(url?.scheme, "https")
    XCTAssertEqual(url?.host, "box")
    XCTAssertTrue(PairDeviceView.hostAndPort(from: "https://box")! == ("box", "443"))
  }

  func testServerURLKeepsExplicitScheme() {
    XCTAssertEqual(
      PairDeviceView.serverURL(from: "http://box:8085")?.absoluteString,
      "http://box:8085"
    )
  }

  func testServerURLRejectsEmpty() {
    XCTAssertNil(PairDeviceView.serverURL(from: "   "))
  }

  // MARK: - NoiseFingerprint

  func testFingerprintIsDeterministicAndGrouped() {
    let key = Data(repeating: 0xAB, count: 32)
    let fp = NoiseFingerprint.short(key)
    XCTAssertEqual(fp, NoiseFingerprint.short(key), "same key → same fingerprint")
    // 8 bytes → 16 hex chars → four groups of four joined by dashes.
    let groups = fp.split(separator: "-")
    XCTAssertEqual(groups.count, 4)
    XCTAssertTrue(groups.allSatisfy { $0.count == 4 })
    XCTAssertNotEqual(fp, NoiseFingerprint.short(Data(repeating: 0xCD, count: 32)))
  }

  func testFullFingerprintMatchesHostFormat() {
    let key = Data(repeating: 0xAB, count: 32)
    let full = NoiseFingerprint.full(key)
    let bare = full.replacingOccurrences(of: " ", with: "")
    // Full 32-byte SHA-256 → 64 lowercase hex chars, grouped in fours by spaces —
    // the exact string the host prints as "Server fingerprint".
    XCTAssertEqual(bare.count, 64)
    XCTAssertEqual(bare, bare.lowercased())
    XCTAssertTrue(bare.allSatisfy { $0.isHexDigit })
    XCTAssertEqual(full.split(separator: " ").count, 16)
    // `short` is the uppercased 16-char prefix of the same digest.
    XCTAssertEqual(
      NoiseFingerprint.short(key).replacingOccurrences(of: "-", with: ""),
      String(bare.prefix(16)).uppercased())
  }
}
