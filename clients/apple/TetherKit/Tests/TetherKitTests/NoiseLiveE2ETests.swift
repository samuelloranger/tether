import XCTest

@testable import TetherKit

/// Live end-to-end test: a real Swift Noise client pairs, reconnects, and runs a
/// shell command against a REAL running tether server over the network.
///
/// Skipped unless `TETHER_E2E_URL` (e.g. http://192.168.50.30:8199) and
/// `TETHER_E2E_CODE` (a fresh `tether pair` code, with the host set to
/// auto-confirm) are both set. This is orchestrated from outside (a server +
/// auto-confirm helper on the host); the test only drives the client side.
final class NoiseLiveE2ETests: XCTestCase {
  func testLivePairReconnectShell() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let urlStr = env["TETHER_E2E_URL"], let code = env["TETHER_E2E_CODE"],
      let url = URL(string: urlStr)
    else {
      throw XCTSkip("set TETHER_E2E_URL + TETHER_E2E_CODE to run the live E2E")
    }

    let hostId = "e2e-\(UUID().uuidString)"
    let client = NoiseSessionClient(keyStore: FakeNoiseKeyStore())

    // Pair: XXpsk2 over /api/noise/pair (host auto-confirms out of band).
    let serverPub = try await client.pair(hostId: hostId, url: url, code: code)
    XCTAssertEqual(serverPub.count, 32, "pinned server key should be 32 bytes")

    // Reconnect: IK over /api/noise/session, authorized against the registry.
    let channel = try await client.reconnect(hostId: hostId, url: url)
    let sid = "ios-e2e-session"
    try await channel.sendStart(id: sid)
    try await Task.sleep(nanoseconds: 500_000_000)
    try await channel.sendInput(id: sid, text: "echo hello-ios-e2e-marker\n")

    // Read sealed output frames until the marker shows up.
    let deadline = Date().addingTimeInterval(12)
    var sawMarker = false
    while Date() < deadline {
      let msg = try await channel.receive()
      if case let .output(_, chunk) = msg, chunk.contains("hello-ios-e2e-marker") {
        sawMarker = true
        break
      }
    }
    await channel.close()
    XCTAssertTrue(sawMarker, "never saw the shell output over the Noise session")
  }
}
