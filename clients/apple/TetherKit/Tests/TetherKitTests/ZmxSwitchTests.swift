import XCTest
@testable import TetherKit

final class ZmxSwitchTests: XCTestCase {
  private let zmx = "~/.local/bin/zmx"

  // The old strategy keyed off the alt-screen, which a CLI agent never takes:
  // switches were typed into the agent instead of switching. With a client
  // attached the answer no longer depends on what runs inside the session.
  func test_switching_with_a_session_attached_detaches_first() {
    XCTAssertEqual(
      ZmxSwitch.strategy(connected: true, attached: true),
      .detachThenAttach
    )
  }

  func test_switching_on_a_host_with_no_session_attaches_at_the_shell() {
    XCTAssertEqual(
      ZmxSwitch.strategy(connected: true, attached: false),
      .attachInPlace
    )
  }

  func test_switching_while_disconnected_redials() {
    XCTAssertEqual(ZmxSwitch.strategy(connected: false, attached: true), .redial)
    XCTAssertEqual(ZmxSwitch.strategy(connected: false, attached: false), .redial)
  }

  func test_a_detaching_switch_sends_the_detach_key_before_the_command() {
    let writes = ZmxSwitch.writes(strategy: .detachThenAttach, zmx: zmx, name: "work")
    // Two elements is the contract that they go out as separate writes: the zmx
    // client discards anything carried in the same read as the detach key.
    XCTAssertEqual(writes.count, 2)
    XCTAssertEqual(writes.first, "\u{1C}")
    XCTAssertEqual(writes.last, "\u{15}\(zmx) attach 'work'\n")
  }

  func test_an_in_place_switch_is_a_single_write_with_no_detach_key() {
    let writes = ZmxSwitch.writes(strategy: .attachInPlace, zmx: zmx, name: "work")
    XCTAssertEqual(writes, ["\(zmx) attach 'work'\n"])
  }

  func test_a_redial_writes_nothing_to_the_old_pty() {
    XCTAssertEqual(ZmxSwitch.writes(strategy: .redial, zmx: zmx, name: "work"), [])
  }

  func test_the_session_name_is_quoted() {
    let writes = ZmxSwitch.writes(strategy: .attachInPlace, zmx: zmx, name: "my project'; rm -rf /")
    XCTAssertEqual(writes, ["\(zmx) attach 'my project'\"'\"'; rm -rf /'\n"])
  }
}
