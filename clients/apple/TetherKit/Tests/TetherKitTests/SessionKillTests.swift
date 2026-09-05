import Foundation
import XCTest

import TetherFFIBindings
@testable import TetherKit

@MainActor
final class SessionKillTests: XCTestCase {
  func testKillDropsTheSessionEvenIfTheNextListIsStale() async throws {
    let hostStore = HostStoreAdapter(storage: InMemoryKillHostStorage())
    let profile = try hostStore.create(
      name: "box",
      color: "#89b4fa",
      host: "192.168.1.9",
      port: "8443",
      identityName: "box"
    )
    let term1 = RemoteSession(
      id: "term-1", status: "running", lastOutputAt: nil, name: nil, autoTitle: nil, activity: nil
    )
    let term3 = RemoteSession(
      id: "term-3", status: "running", lastOutputAt: nil, name: nil, autoTitle: nil, activity: nil
    )
    var killed: [(String, String)] = []
    let store = SessionStore(
      hostStore: hostStore,
      noiseKeyStore: FakeNoiseKeyStore(),
      remoteSessions: { _ in [term1, term3] },
      remoteKill: { hostId, sessionId in
        killed.append((hostId, sessionId))
      }
    )
    store.reloadHosts()
    store.activeHostId = profile.id
    await store.refreshDrawer()
    XCTAssertEqual(store.sessions.map(\.id), ["term-1", "term-3"])

    await store.killSession(id: "term-3", hostId: profile.id)

    XCTAssertEqual(killed.map(\.1), ["term-3"])
    XCTAssertEqual(store.sessions.map(\.id), ["term-1"])
    XCTAssertEqual(store.sessionsByHost[profile.id]?.map(\.id), ["term-1"])
  }
}

private final class InMemoryKillHostStorage: HostStorage {
  private var items: [String: String] = [:]
  func getItem(key: String) throws -> String? { items[key] }
  func setItem(key: String, value: String) throws { items[key] = value }
  func removeItem(key: String) throws { items[key] = nil }
}
