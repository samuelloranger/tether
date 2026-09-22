import XCTest
@testable import TetherKit

/// A dimmed Save button tells a sighted user nothing and a VoiceOver user even
/// less. Each form says which field is still missing, in the order the form
/// asks for them.
final class FormReadinessTests: XCTestCase {
  func test_a_complete_key_backed_server_is_ready() {
    XCTAssertNil(FormReadiness.serverBlocker(
      name: "homelab", host: "example.internal", username: "sam", usesPassword: false, password: "", hasKey: true))
  }

  func test_the_first_missing_server_field_is_the_one_reported() {
    XCTAssertEqual(
      FormReadiness.serverBlocker(name: "", host: "", username: "", usesPassword: false, password: "", hasKey: false),
      "Name this machine to save it")
    XCTAssertEqual(
      FormReadiness.serverBlocker(name: "homelab", host: "", username: "", usesPassword: false, password: "", hasKey: false),
      "Add a host to save it")
    XCTAssertEqual(
      FormReadiness.serverBlocker(name: "homelab", host: "example.internal", username: "", usesPassword: false, password: "", hasKey: false),
      "Add a user to save it")
  }

  func test_password_auth_reports_the_password_and_key_auth_reports_the_key() {
    XCTAssertEqual(
      FormReadiness.serverBlocker(name: "h", host: "e", username: "u", usesPassword: true, password: "", hasKey: true),
      "Enter a password to save it")
    XCTAssertEqual(
      FormReadiness.serverBlocker(name: "h", host: "e", username: "u", usesPassword: false, password: "", hasKey: false),
      "Choose a key to save it")
  }

  func test_whitespace_is_not_a_value() {
    XCTAssertEqual(
      FormReadiness.serverBlocker(name: "   ", host: "e", username: "u", usesPassword: false, password: "", hasKey: true),
      "Name this machine to save it")
  }

  func test_generating_a_key_only_needs_a_name() {
    XCTAssertEqual(FormReadiness.keyBlocker(name: "", needsMaterial: false, pem: "", publicKey: ""), "Name this key to save it")
    XCTAssertNil(FormReadiness.keyBlocker(name: "phone", needsMaterial: false, pem: "", publicKey: ""))
  }

  func test_an_imported_key_needs_both_halves_in_the_right_shape() {
    let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
    XCTAssertEqual(
      FormReadiness.keyBlocker(name: "laptop", needsMaterial: true, pem: "", publicKey: "ssh-ed25519 AAAA"),
      "Paste the private key to save it")
    // A public key pasted into the private field is the common slip, and it is
    // the private-key message that must come back.
    XCTAssertEqual(
      FormReadiness.keyBlocker(name: "laptop", needsMaterial: true, pem: "ssh-ed25519 AAAA", publicKey: "ssh-ed25519 AAAA"),
      "Paste the private key to save it")
    XCTAssertEqual(
      FormReadiness.keyBlocker(name: "laptop", needsMaterial: true, pem: pem, publicKey: "not a key"),
      "Paste the public key to save it")
    XCTAssertNil(
      FormReadiness.keyBlocker(name: "laptop", needsMaterial: true, pem: pem, publicKey: " ssh-ed25519 AAAA "))
  }
}
