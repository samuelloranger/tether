import Foundation
import XCTest

@testable import TetherKit

/// A lock-guarded box so the injected `@Sendable` clock/mint closures can share
/// mutable test state across the cache actor's executor without data races.
private final class Box<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: T
  init(_ value: T) { self.value = value }
  var current: T {
    lock.lock(); defer { lock.unlock() }
    return value
  }
  func set(_ newValue: T) {
    lock.lock(); value = newValue; lock.unlock()
  }
  func mutate(_ body: (inout T) -> Void) {
    lock.lock(); body(&value); lock.unlock()
  }
}

/// Pure-logic coverage for `NoiseTokenCache`: reuse-until-refresh, re-mint past
/// the refresh point, and invalidate — all with an injected clock + mint, no
/// network.
final class NoiseTokenCacheTests: XCTestCase {
  /// Builds a cache whose mint returns `token-<n>` with a 100s lifetime measured
  /// from the current injected clock. Returns the cache plus the shared clock and
  /// mint-count boxes so a test can advance time and assert mint counts.
  private func makeCache() -> (cache: NoiseTokenCache, clock: Box<Date>, mints: Box<Int>) {
    let clock = Box(Date(timeIntervalSince1970: 1_000_000))
    let mints = Box(0)
    let cache = NoiseTokenCache(
      now: { clock.current },
      mint: { _ in
        mints.mutate { $0 += 1 }
        let n = mints.current
        return ("token-\(n)", clock.current.addingTimeInterval(100))
      }
    )
    return (cache, clock, mints)
  }

  /// First call mints; a second call before the refresh point reuses the same
  /// token without minting again.
  func testMintsOnceThenReuses() async throws {
    let (cache, clock, mints) = makeCache()

    let first = try await cache.token(for: "host-a")
    XCTAssertEqual(first, "token-1")
    XCTAssertEqual(mints.current, 1)

    // Same instant → reuse.
    let reused = try await cache.token(for: "host-a")
    XCTAssertEqual(reused, "token-1")
    XCTAssertEqual(mints.current, 1)

    // 80s in (refresh point is 90s = 90% of the 100s lifetime) → still reuse.
    clock.set(clock.current.addingTimeInterval(80))
    let stillReused = try await cache.token(for: "host-a")
    XCTAssertEqual(stillReused, "token-1")
    XCTAssertEqual(mints.current, 1)
  }

  /// Past the 90%-of-lifetime refresh point, the cache re-mints.
  func testRefreshesNearExpiry() async throws {
    let (cache, clock, mints) = makeCache()

    let first = try await cache.token(for: "host-a")
    XCTAssertEqual(first, "token-1")
    XCTAssertEqual(mints.current, 1)

    // 95s in → past the 90s refresh point → re-mint.
    clock.set(clock.current.addingTimeInterval(95))
    let refreshed = try await cache.token(for: "host-a")
    XCTAssertEqual(refreshed, "token-2")
    XCTAssertEqual(mints.current, 2)
  }

  /// `invalidate` forces the next call to re-mint even though the token is not
  /// near expiry (the 401 path).
  func testInvalidateForcesRemint() async throws {
    let (cache, _, mints) = makeCache()

    let first = try await cache.token(for: "host-a")
    XCTAssertEqual(first, "token-1")
    XCTAssertEqual(mints.current, 1)

    await cache.invalidate(hostId: "host-a")

    let reminted = try await cache.token(for: "host-a")
    XCTAssertEqual(reminted, "token-2")
    XCTAssertEqual(mints.current, 2)
  }

  /// Tokens are cached per host: two hosts each mint independently.
  func testPerHostIsolation() async throws {
    let (cache, _, mints) = makeCache()

    let a = try await cache.token(for: "host-a")
    let b = try await cache.token(for: "host-b")
    XCTAssertEqual(a, "token-1")
    XCTAssertEqual(b, "token-2")
    XCTAssertEqual(mints.current, 2)

    // Each host still reuses its own cached token.
    let a2 = try await cache.token(for: "host-a")
    let b2 = try await cache.token(for: "host-b")
    XCTAssertEqual(a2, "token-1")
    XCTAssertEqual(b2, "token-2")
    XCTAssertEqual(mints.current, 2)
  }
}
