import XCTest
@testable import TetherKit

final class SSHAuthOrderTests: XCTestCase {
  private let pw = SSHCredential.password("pw")
  private let keyA = SSHCredential.privateKey(pem: "A", passphrase: nil)
  private let keyB = SSHCredential.privateKey(pem: "B", passphrase: nil)

  func test_returns_the_first_credential_that_authenticates_and_stops() throws {
    var tried: [SSHCredential] = []
    let winner = try authenticateInOrder([pw, keyA]) { cred in
      tried.append(cred)
      return true
    }
    XCTAssertEqual(winner, pw)
    XCTAssertEqual(tried, [pw]) // did not touch the rest
  }

  func test_skips_rejected_credentials_until_one_succeeds() throws {
    var tried: [SSHCredential] = []
    let winner = try authenticateInOrder([keyA, keyB, pw]) { cred in
      tried.append(cred)
      return cred == pw
    }
    XCTAssertEqual(winner, pw)
    XCTAssertEqual(tried, [keyA, keyB, pw])
  }

  func test_throws_allFailed_when_every_credential_is_rejected() {
    XCTAssertThrowsError(try authenticateInOrder([keyA, keyB]) { _ in false }) { error in
      XCTAssertEqual(error as? SSHAuthError, .allFailed)
    }
  }

  func test_throws_noCredentials_for_an_empty_list() {
    XCTAssertThrowsError(try authenticateInOrder([]) { _ in true }) { error in
      XCTAssertEqual(error as? SSHAuthError, .noCredentials)
    }
  }

  func test_transport_error_aborts_immediately_without_trying_the_rest() {
    struct Boom: Error {}
    var tried: [SSHCredential] = []
    XCTAssertThrowsError(try authenticateInOrder([keyA, keyB]) { cred in
      tried.append(cred)
      throw Boom()
    }) { error in
      XCTAssertTrue(error is Boom)
    }
    XCTAssertEqual(tried, [keyA]) // stopped at the transport failure
  }
}
