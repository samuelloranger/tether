import Foundation
import XCTest
@testable import TetherKit

final class SSHRandomartTests: XCTestCase {
  // SHA-256 digest of the ed25519 pub blob used across the SSH key tests.
  private let digest = Data([
    0xa9, 0x0b, 0x9b, 0x50, 0x99, 0xb3, 0xaa, 0x5b, 0x90, 0xe6, 0x59, 0xa3, 0x29, 0x4c, 0xb7, 0x6b,
    0x03, 0x74, 0xe1, 0x0b, 0xf4, 0xb6, 0xcd, 0x67, 0xaf, 0x8a, 0x59, 0x59, 0x2d, 0xa0, 0x23, 0xca,
  ])

  func test_matches_ssh_keygen_drunken_bishop_output() {
    let expected = """
      +--[ED25519 256]--+
      |                 |
      | . .             |
      |. o ..           |
      | + =.o. ..       |
      |+++*X  oS.       |
      |BoB++=o+.        |
      |oE+.oo+ .        |
      |.. ==+ . .       |
      |ooo++.o..        |
      +----[SHA256]-----+
      """
    let art = SSHRandomart.render(digest: digest, title: "[ED25519 256]", footer: "[SHA256]")
    XCTAssertEqual(art, expected)
  }
}
