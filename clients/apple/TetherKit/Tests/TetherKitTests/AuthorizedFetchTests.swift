import XCTest

@testable import TetherKit

/// One-shot 401 → invalidate → re-mint → retry for authorized REST calls.
final class AuthorizedFetchTests: XCTestCase {
  private let testURL = URL(string: "https://example.test/api/resource")!

  func test401Then200RemintsOnce() async throws {
    var bearerCalls = 0
    var invalidateCalls = 0

    let (data, status) = try await AuthorizedHTTP.sendAuthorizedOnce(
      bearer: {
        bearerCalls += 1
        return "token-\(bearerCalls)"
      },
      invalidate: { invalidateCalls += 1 },
      url: testURL,
      data: { request in
        let auth = request.value(forHTTPHeaderField: "Authorization")
        if auth == "Bearer token-1" {
          return (Data(), 401)
        }
        XCTAssertEqual(auth, "Bearer token-2")
        return (Data("ok".utf8), 200)
      }
    )

    XCTAssertEqual(status, 200)
    XCTAssertEqual(String(data: data, encoding: .utf8), "ok")
    XCTAssertEqual(bearerCalls, 2)
    XCTAssertEqual(invalidateCalls, 1)
  }

  func testDouble401DoesNotLoop() async throws {
    var bearerCalls = 0
    var invalidateCalls = 0
    var dataCalls = 0

    let (data, status) = try await AuthorizedHTTP.sendAuthorizedOnce(
      bearer: {
        bearerCalls += 1
        return "token-\(bearerCalls)"
      },
      invalidate: { invalidateCalls += 1 },
      url: testURL,
      data: { _ in
        dataCalls += 1
        return (Data(), 401)
      }
    )

    XCTAssertEqual(status, 401)
    XCTAssertTrue(data.isEmpty)
    XCTAssertEqual(bearerCalls, 2)
    XCTAssertEqual(invalidateCalls, 1)
    XCTAssertEqual(dataCalls, 2)
  }
}
