import XCTest
@testable import TetherKit

@MainActor
final class SSHTerminalControllerBellTests: XCTestCase {
  private let config = SSHConnectionConfig(
    host: "example.internal", port: 22, username: "sam", credentials: [.password("pw")])

  private final class Flag { var value = false }

  private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<200 where !condition() {
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(condition(), "timed out", file: file, line: line)
  }

  func test_a_bell_rings_only_while_the_app_is_active() async {
    let stream = ScriptedByteStream()
    let store = InMemoryHostKeyStore()
    let script = DialScript([stream])
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work",
      dial: { try await script.dial($0, $1) },
      control: ControlConnection(config: config, store: store) { FakeOps() })
    let active = Flag()
    controller.appIsActive = { active.value }
    await controller.connect()

    // The mouse-mode change in the same chunk shows the chunk was handled.
    stream.push(Data("\u{07}\u{1B}[?1000h".utf8))
    await waitUntil { controller.mouseMode != .off }
    XCTAssertEqual(controller.bellRings, 0, "a bell in the background must not ring later")

    active.value = true
    stream.push(Data("\u{07}".utf8))
    await waitUntil { controller.bellRings == 1 }
    await controller.leave()
  }
}

@MainActor
final class SSHTerminalControllerReportTests: XCTestCase {
  private let config = SSHConnectionConfig(
    host: "example.internal", port: 22, username: "sam", credentials: [.password("pw")])

  private final class Sink { var written: [String] = []; var active = false }

  private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<200 where !condition() {
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(condition(), "timed out", file: file, line: line)
  }

  func test_report_and_clipboard_reach_the_controller() async {
    let stream = ScriptedByteStream()
    let store = InMemoryHostKeyStore()
    let script = DialScript([stream])
    let controller = SSHTerminalController(
      title: "test", config: config, hostKeyStore: store, attach: "work",
      dial: { try await script.dial($0, $1) },
      control: ControlConnection(config: config, store: store) { FakeOps() })
    let sink = Sink()
    controller.appIsActive = { sink.active }
    controller.writeClipboard = { sink.written.append($0) }
    await controller.connect()

    stream.push(Data("\u{1B}]2;vim\u{07}\u{1B}]9;4;1;30\u{07}\u{1B}]52;c;aGk=\u{07}\u{1B}[?1000h".utf8))
    await waitUntil { controller.mouseMode != .off && controller.terminalReport.title == "vim" }
    XCTAssertEqual(controller.terminalReport.progress, TerminalProgress(state: .normal, percent: 30))
    XCTAssertEqual(sink.written, [], "the clipboard is not written while the app is in the background")

    sink.active = true
    stream.push(Data("\u{1B}]52;c;aGk=\u{07}".utf8))
    await waitUntil { !sink.written.isEmpty }
    XCTAssertEqual(sink.written, ["hi"])
    await controller.leave()
  }
}
