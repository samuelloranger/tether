import Foundation
import XCTest
@testable import TetherKit

/// Vectors from openssl + ssh-keygen for one ed25519 key:
///   seed 0b8a44…701b, pub babf04…17f3
final class SSHKeyEncodingTests: XCTestCase {
  private let seed = Data([
    0x0b, 0x8a, 0x44, 0x0c, 0x22, 0x48, 0x54, 0xfb, 0x4f, 0x88, 0x1b, 0x1b, 0xed, 0x94, 0x74, 0x57,
    0xf9, 0x89, 0x5f, 0x09, 0xbc, 0x28, 0xe8, 0xf0, 0xe8, 0xfb, 0xff, 0x54, 0x36, 0x87, 0x70, 0x1b,
  ])
  private let pub = Data([
    0xba, 0xbf, 0x04, 0x3b, 0xfb, 0x1a, 0x9f, 0xf5, 0xc3, 0x30, 0x4c, 0x17, 0xe0, 0xef, 0x11, 0x7e,
    0xa6, 0x58, 0x92, 0x11, 0xd0, 0xdf, 0x15, 0xc0, 0x10, 0xe8, 0x36, 0x2c, 0x8c, 0x71, 0x17, 0xf3,
  ])
  private let openSSHPub =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILq/BDv7Gp/1wzBMF+DvEX6mWJIR0N8VwBDoNiyMcRfz"
  private let fingerprint = "SHA256:qQubUJmzqluQ5lmjKUy3awN04Qv0ts1nr4pZWS2gI8o"

  func test_builds_the_openssh_public_key_line_from_raw_ed25519_bytes() {
    XCTAssertEqual(SSHKeyEncoding.openSSHPublicKey(rawEd25519: pub, comment: nil), openSSHPub)
  }

  func test_appends_a_comment_when_given_one() {
    XCTAssertEqual(
      SSHKeyEncoding.openSSHPublicKey(rawEd25519: pub, comment: "me@phone"),
      openSSHPub + " me@phone"
    )
  }

  func test_wraps_the_seed_as_a_pkcs8_pem_openssl_reads() {
    let pem = SSHKeyEncoding.pkcs8PEM(ed25519Seed: seed)
    XCTAssertTrue(pem.hasPrefix("-----BEGIN PRIVATE KEY-----"))
    XCTAssertTrue(pem.contains("MC4CAQAwBQYDK2VwBCIEIAuKRAwiSFT7T4gbG+2UdFf5iV8JvCjo8Oj7/1Q2h3Ab"))
    XCTAssertTrue(pem.hasSuffix("-----END PRIVATE KEY-----\n"))
  }

  func test_computes_the_sha256_fingerprint_like_ssh_keygen() {
    XCTAssertEqual(SSHKeyEncoding.fingerprint(openSSHPublicKey: openSSHPub), fingerprint)
  }
}
