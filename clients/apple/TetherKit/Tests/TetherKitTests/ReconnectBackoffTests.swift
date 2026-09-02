import XCTest

@testable import TetherKit

final class ReconnectBackoffTests: XCTestCase {
  // Values pinned against the Rust `backoff_delay` (random_unit = 0 → band floor).
  func testDelayFloorMatchesRust() {
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 0, randomUnit: 0), 500)
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 1, randomUnit: 0), 1_000)
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 2, randomUnit: 0), 2_000)
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 3, randomUnit: 0), 4_000)
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 4, randomUnit: 0), 8_000)
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 5, randomUnit: 0), 15_000)
  }

  func testDelayCapsAtAttemptFive() {
    // exponent is clamped to 5, so 30s base / 15s floor holds for any higher attempt.
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 6, randomUnit: 0), 15_000)
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 99, randomUnit: 0), 15_000)
  }

  func testJitterStaysInUpperHalfBand() {
    // random_unit = 1 → floor + (half - 1); never reaches the full base.
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 0, randomUnit: 1.0), 999)
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 2, randomUnit: 1.0), 3_999)
    // out-of-range units are clamped
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 0, randomUnit: -5), 500)
    XCTAssertEqual(ReconnectBackoff.delayMs(attempt: 0, randomUnit: 5), 999)
  }

  func testRetryResetsOnlyAfterHealthyLifetime() {
    // Lived >= healthy → reset to 0.
    XCTAssertEqual(
      ReconnectBackoff.retryAfterClose(retry: 3, openedAtMs: 1_000, nowMs: 12_000), 0)
    // Lived < healthy → keep the count.
    XCTAssertEqual(
      ReconnectBackoff.retryAfterClose(retry: 3, openedAtMs: 1_000, nowMs: 5_000), 3)
    // Never opened → keep the count.
    XCTAssertEqual(
      ReconnectBackoff.retryAfterClose(retry: 3, openedAtMs: 0, nowMs: 999_999), 3)
  }
}
