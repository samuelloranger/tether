import Foundation
import SwiftUI
import XCTest

import TetherFFIBindings
@testable import TetherKit

#if canImport(UIKit)
import UIKit

/// Renders the new Aurora-styled pairing / devices screens to real PNGs by
/// hosting each state in a key `UIWindow`, forcing layout, and rasterising the
/// window. Each render is attached to the test result as an `XCTAttachment`
/// whose `name` is the state key, so the .xcresult can be exported to one PNG
/// per state. Uses the app's default dark Aurora appearance.
///
/// This is a snapshot generator, not an assertion suite: it drives the
/// `#if DEBUG` snapshot seams on `PairDeviceView` / `DevicesView` /
/// `DevicesModel` and always passes once each attachment is captured.
@MainActor
final class SnapshotGen: XCTestCase {
  /// iPhone 14 Pro Max, portrait, in points.
  private let deviceSize = CGSize(width: 430, height: 932)

  /// A deterministic 32-byte device private key so the derived self-fingerprint
  /// on the waiting screen is stable across runs. Any 32 bytes is a valid
  /// X25519 scalar (clamped on use), so this yields a REAL derived fingerprint.
  private let knownDeviceKey = Data((0 ..< 32).map { UInt8(($0 * 7 + 3) & 0xFF) })

  /// A deterministic 32-byte pinned server key for the success screen.
  private let pinnedServerKey = Data((0 ..< 32).map { UInt8(($0 * 11 + 5) & 0xFF) })

  // MARK: - PairDeviceView

  func testPairEnterCodeEmpty() {
    render(
      name: "enter-code-empty",
      view: PairDeviceView(
        snapshotClient: NoiseSessionClient(keyStore: FakeNoiseKeyStore()),
        hostId: "snapshot",
        phase: .enterCode
      )
    )
  }

  func testPairEnterCodeFilled() {
    render(
      name: "enter-code-filled",
      view: PairDeviceView(
        snapshotClient: NoiseSessionClient(keyStore: FakeNoiseKeyStore()),
        hostId: "snapshot",
        initialHost: "homelab.local:8443",
        initialCode: "7QF4KM9PX3TV",
        phase: .enterCode
      )
    )
  }

  func testPairWaitingFingerprint() throws {
    // Preload a key store with a known device key so the waiting screen shows
    // the REAL derived self-fingerprint rather than the placeholder.
    let store = FakeNoiseKeyStore()
    try store.saveDevicePrivateKey(knownDeviceKey, hostId: "snapshot")
    render(
      name: "waiting-fingerprint",
      view: PairDeviceView(
        snapshotClient: NoiseSessionClient(keyStore: store),
        hostId: "snapshot",
        initialHost: "homelab.local:8443",
        phase: .pairing
      )
    )
  }

  func testPairSuccess() {
    render(
      name: "success",
      view: PairDeviceView(
        snapshotClient: NoiseSessionClient(keyStore: FakeNoiseKeyStore()),
        hostId: "snapshot",
        initialHost: "homelab.local:8443",
        phase: .success,
        pinnedKey: pinnedServerKey
      )
    )
  }

  func testPairFailure() {
    render(
      name: "failure",
      view: PairDeviceView(
        snapshotClient: NoiseSessionClient(keyStore: FakeNoiseKeyStore()),
        hostId: "snapshot",
        initialHost: "homelab.local:8443",
        phase: .failure,
        errorMessage: "Pairing rejected by server: code expired"
      )
    )
  }

  // MARK: - DevicesView

  func testDevicesList() {
    let model = DevicesModel(
      snapshotPhase: .loaded,
      devices: [
        DeviceInfo(
          id: "dev-1",
          label: "Sam's iPhone 15 Pro",
          fingerprint: "9F2A C4D1 77B0 3E5C 8810 A6F4 22DD 91BE",
          pairedAt: "2026-08-30 14:02",
          lastSeenAt: "2026-09-04 08:41",
          lastAddress: "192.168.50.44",
          isSelf: true
        ),
        DeviceInfo(
          id: "dev-2",
          label: "homelab desktop (Linux)",
          fingerprint: "1B7E 44A2 90CF D3E1 6605 8B2A F719 40CC",
          pairedAt: "2026-08-12 09:15",
          lastSeenAt: "2026-09-03 22:10",
          lastAddress: "192.168.50.30",
          isSelf: false
        ),
        DeviceInfo(
          id: "dev-3",
          label: "Work MacBook Pro",
          fingerprint: "C302 A9F5 11B8 7742 DE0A 3C6B 8845 21F0",
          pairedAt: "2026-07-28 18:44",
          lastSeenAt: nil,
          lastAddress: nil,
          isSelf: false
        ),
      ]
    )
    render(name: "devices-list", view: DevicesView(snapshotModel: model))
  }

  func testDevicesEmpty() {
    let model = DevicesModel(
      snapshotPhase: .loaded,
      devices: [
        DeviceInfo(
          id: "dev-1",
          label: "Sam's iPhone 15 Pro",
          fingerprint: "9F2A C4D1 77B0 3E5C 8810 A6F4 22DD 91BE",
          pairedAt: "2026-08-30 14:02",
          lastSeenAt: "2026-09-04 08:41",
          lastAddress: "192.168.50.44",
          isSelf: true
        ),
      ]
    )
    render(name: "devices-empty", view: DevicesView(snapshotModel: model))
  }

  func testDevicesError() {
    let model = DevicesModel(
      snapshotPhase: .failed("Couldn't reach homelab: connection refused (is the host online?)"),
      devices: []
    )
    render(name: "devices-error", view: DevicesView(snapshotModel: model))
  }

  // MARK: - Render + attach

  private func render<V: View>(name: String, view: V) {
    let image = rasterize(NavigationStack { view })
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Host `view` in a key window sized to the device, force layout, and
  /// rasterise the window in the dark Aurora appearance.
  private func rasterize<V: View>(_ view: V) -> UIImage {
    let host = UIHostingController(rootView: view)
    let window = UIWindow(frame: CGRect(origin: .zero, size: deviceSize))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = host
    window.makeKeyAndVisible()

    host.view.frame = window.bounds
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
    // Give SwiftUI a beat to build the Form/List content before capture.
    RunLoop.main.run(until: Date().addingTimeInterval(0.4))
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()

    let format = UIGraphicsImageRendererFormat()
    format.scale = 3 // iPhone 14 Pro Max is @3x
    let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
    // `drawHierarchy(afterScreenUpdates:)` needs the window/render server, which a
    // logic-test bundle (no app host) does not have — it returns a blank frame.
    // `layer.render(in:)` rasterises the laid-out CALayer tree directly instead.
    return renderer.image { ctx in
      window.layer.render(in: ctx.cgContext)
    }
  }
}
#endif
