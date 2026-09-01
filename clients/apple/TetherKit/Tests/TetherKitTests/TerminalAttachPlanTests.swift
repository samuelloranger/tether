import XCTest
@testable import TetherKit

final class TerminalAttachPlanTests: XCTestCase {
  func test_reconnecting_to_the_same_session_keeps_the_emulator_and_the_cursor() {
    let plan = TerminalAttachPlan.plan(emulatorKey: "h1:alpha", hasEmulator: true, key: "h1:alpha")
    XCTAssertFalse(plan.rebuildEmulator)
    XCTAssertFalse(plan.rewindReplayCursor, "the grid still holds this session's history — replay must resume from it")
  }

  /// The bug this pairing exists for: switching A -> B -> A rebuilt A's emulator
  /// empty but left A's cursor at the tip, so the server replayed nothing. The
  /// terminal came back blank, with no scrollback to pan into.
  func test_switching_to_another_session_rebuilds_and_rewinds() {
    let plan = TerminalAttachPlan.plan(emulatorKey: "h1:bravo", hasEmulator: true, key: "h1:alpha")
    XCTAssertTrue(plan.rebuildEmulator)
    XCTAssertTrue(plan.rewindReplayCursor)
  }

  func test_same_session_id_on_another_host_is_not_the_same_terminal() {
    let plan = TerminalAttachPlan.plan(emulatorKey: "h2:alpha", hasEmulator: true, key: "h1:alpha")
    XCTAssertTrue(plan.rebuildEmulator)
    XCTAssertTrue(plan.rewindReplayCursor)
  }

  func test_no_cached_emulator_rebuilds_and_rewinds() {
    let plan = TerminalAttachPlan.plan(emulatorKey: nil, hasEmulator: false, key: "h1:alpha")
    XCTAssertTrue(plan.rebuildEmulator)
    XCTAssertTrue(plan.rewindReplayCursor)
  }

  /// `release()` clears the emulator without clearing `emulatorKey`'s meaning:
  /// a stale key with no emulator must still rebuild AND rewind.
  func test_stale_key_without_an_emulator_still_rewinds() {
    let plan = TerminalAttachPlan.plan(emulatorKey: "h1:alpha", hasEmulator: false, key: "h1:alpha")
    XCTAssertTrue(plan.rebuildEmulator)
    XCTAssertTrue(plan.rewindReplayCursor)
  }
}
