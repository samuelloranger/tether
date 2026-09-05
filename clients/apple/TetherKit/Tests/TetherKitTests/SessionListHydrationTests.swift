import Foundation
import XCTest

import TetherFFIBindings
@testable import TetherKit

/// In-memory `HostStorage` double — same shape as NoiseHostPersistenceTests.
private final class InMemoryHostStorage: HostStorage {
  private var items: [String: String] = [:]
  func getItem(key: String) throws -> String? { items[key] }
  func setItem(key: String, value: String) throws { items[key] = value }
  func removeItem(key: String) throws { items[key] = nil }
}

/// Cold launch used to ping Noise and return the empty in-memory tab cache,
/// so the drawer stayed blank until the user tapped New terminal (which
/// synthesized `term-1` and reattached the live PTY). Hydration must come
/// from `GET /api/sessions` (or a test double of it).
@MainActor
final class SessionListHydrationTests: XCTestCase {
  func testColdRefreshHydratesSessionsFromTheServerList() async throws {
    let hostStore = HostStoreAdapter(storage: InMemoryHostStorage())
    let profile = try hostStore.create(
      name: "box",
      color: "#89b4fa",
      host: "192.168.1.9",
      port: "8443",
      identityName: "box"
    )
    let listed = [
      RemoteSession(
        id: "term-1", status: "running", lastOutputAt: nil, name: nil, autoTitle: nil, activity: nil
      ),
    ]
    var asked: [String] = []
    let store = SessionStore(
      hostStore: hostStore,
      noiseKeyStore: FakeNoiseKeyStore(),
      remoteSessions: { hostId in
        asked.append(hostId)
        return listed
      }
    )
    store.reloadHosts()
    store.activeHostId = profile.id

    await store.refreshDrawer()

    XCTAssertEqual(asked, [profile.id])
    XCTAssertEqual(store.sessions.map(\.id), ["term-1"])
    XCTAssertEqual(store.sessionsByHost[profile.id]?.map(\.id), ["term-1"])
  }

  func testAListFailureMarksTheHostUnreachableAndKeepsTheCache() async throws {
    let hostStore = HostStoreAdapter(storage: InMemoryHostStorage())
    let profile = try hostStore.create(
      name: "box",
      color: "#89b4fa",
      host: "192.168.1.9",
      port: "8443",
      identityName: "box"
    )
    let store = SessionStore(
      hostStore: hostStore,
      noiseKeyStore: FakeNoiseKeyStore(),
      remoteSessions: { _ in throw HostClientError.httpStatus(500) }
    )
    store.reloadHosts()
    store.activeHostId = profile.id

    await store.refreshDrawer()

    XCTAssertEqual(store.sessions, [])
    XCTAssertEqual(store.healthByHost[profile.id]?.isUnavailable, true)
  }
}
