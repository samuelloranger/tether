import XCTest
@testable import TetherKit

@MainActor
final class ACPHostCheckTests: XCTestCase {
  func test_the_command_runs_a_quoted_posix_script_whatever_the_login_shell() {
    XCTAssertFalse(ACPHostCheck.script.contains("'"), "the script must survive single-quote wrapping")
    XCTAssertEqual(ACPHostCheck.command, "sh -c " + shellQuote(ACPHostCheck.script))
    XCTAssertTrue(ACPHostCheck.script.contains("command -v npx"))
    XCTAssertTrue(ACPHostCheck.script.contains("tether-notify acp ls"))
    XCTAssertTrue(ACPHostCheck.script.hasPrefix("PATH=\"$HOME/.local/bin:$PATH\"; export PATH"))
  }

  func test_the_report_parses_into_problems() {
    XCTAssertEqual(ACPHostCheck.problems(in: "notify=ok\nnode=ok\n"), [])
    XCTAssertEqual(ACPHostCheck.problems(in: "notify=missing\nnode=ok\n"), [.notifyMissing])
    XCTAssertEqual(ACPHostCheck.problems(in: "notify=old\nnode=missing\n"), [.notifyOutdated, .nodeMissing])
    XCTAssertEqual(ACPHostCheck.problems(in: "node=missing"), [.nodeMissing])
    XCTAssertEqual(ACPHostCheck.problems(in: "  notify=old \r\n"), [.notifyOutdated])
    XCTAssertEqual(ACPHostCheck.problems(in: ""), [], "a host that said nothing is not blamed")
    XCTAssertEqual(ACPHostCheck.problems(in: "welcome back!\nnotify=ok\n"), [])
  }

  func test_each_problem_has_a_plain_message_naming_the_host() {
    XCTAssertNil(ACPHostCheck.message(for: [], host: "box"))
    XCTAssertEqual(
      ACPHostCheck.message(for: [.notifyOutdated], host: "box"),
      "Update tether-notify on box. Chat needs a newer version.")
    XCTAssertEqual(
      ACPHostCheck.message(for: [.notifyMissing], host: "box"),
      "Update tether-notify on box. Chat needs a newer version.")
    XCTAssertEqual(ACPHostCheck.message(for: [.nodeMissing], host: "box"), "Node.js is required on box.")
    XCTAssertEqual(
      ACPHostCheck.message(for: [.notifyMissing, .nodeMissing], host: "box"),
      "Update tether-notify on box. Chat needs a newer version. Node.js is required on box.")
  }

  func test_starting_a_chat_stops_before_spawning_on_a_host_that_fails_a_check() async {
    var commands: [String] = []
    let start = await ChatRoute.start(cwdText: "/srv", host: "box") { command in
      commands.append(command)
      return "notify=old\nnode=ok\n"
    }
    XCTAssertEqual(start, .failed("Update tether-notify on box. Chat needs a newer version."))
    XCTAssertEqual(commands, [ACPHostCheck.command], "nothing else runs, and no agent is spawned")

    let node = await ChatRoute.start(cwdText: "/srv", host: "box") { _ in "notify=ok\nnode=missing\n" }
    XCTAssertEqual(node, .failed("Node.js is required on box."))
  }

  func test_a_ready_host_gets_a_route_and_an_unreachable_check_does_not_block() async {
    let ready = await ChatRoute.start(cwdText: "~/p", host: "box") { command in
      command == ACPHostCheck.command ? "notify=ok\nnode=ok\n" : "/home/dev"
    }
    guard case let .ready(route) = ready else { return XCTFail("\(ready)") }
    XCTAssertEqual(route.cwd, "/home/dev/p")
    XCTAssertFalse(route.readOnly)

    let flaky = await ChatRoute.start(cwdText: "/srv", host: "box") { command in
      if command == ACPHostCheck.command { throw SSHConnectError.transport("blip") }
      return ""
    }
    guard case .ready = flaky else { return XCTFail("\(flaky)") }

    let noHome = await ChatRoute.start(cwdText: "~", host: "box") { command in
      if command == ACPHostCheck.command { return "notify=ok\nnode=ok" }
      throw SSHConnectError.transport("down")
    }
    XCTAssertEqual(noHome, .failed("Couldn't read the host's home folder."))
  }

  func test_the_chat_list_shows_the_reason_under_the_start_button_and_clears_it() async {
    let report = LockedBox("notify=ok\nnode=missing\n")
    let model = ChatListModel(hostName: "box") { command in
      command == ACPHostCheck.command ? report.value : "/home/dev"
    }
    let blocked = await model.newRoute(cwdText: "/srv")
    XCTAssertNil(blocked)
    XCTAssertEqual(model.startError, "Node.js is required on box.")
    XCTAssertNil(model.errorMessage, "a normal row, not the generic alert")

    report.value = "notify=ok\nnode=ok\n"
    let route = await model.newRoute(cwdText: "/srv")
    XCTAssertNotNil(route)
    XCTAssertNil(model.startError)
  }

  func test_a_host_with_a_too_old_tether_notify_explains_itself_in_the_list() async {
    let model = ChatListModel(hostName: "box") { _ in "tether-notify: unknown command \"acp\"\nusage: ...\n" }
    await model.refresh()
    guard case let .failed(message) = model.load else { return XCTFail() }
    XCTAssertTrue(message.hasPrefix("Update tether-notify on box."))
  }
}
