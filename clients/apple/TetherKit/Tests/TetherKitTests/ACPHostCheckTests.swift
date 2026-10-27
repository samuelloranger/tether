import XCTest
@testable import TetherKit

@MainActor
final class ACPHostCheckTests: XCTestCase {
  private static let ours = "tether=found\nversion={\"name\":\"tether\",\"version\":\"v6.1.0\",\"protocol\":1}\nnode=ok\n"

  func test_the_report_judges_only_what_the_picked_agent_needs() {
    let missing = ACPHostCheck.problems(in: Self.ours + "opencode=missing\n")
    XCTAssertEqual(missing, [.opencodeMissing])
    XCTAssertEqual(ACPHostCheck.relevant(missing, for: ChatAgents.opencode), [.opencodeMissing])
    XCTAssertEqual(ACPHostCheck.relevant(missing, for: ChatAgents.claude), [])
    XCTAssertEqual(ACPHostCheck.relevant(missing, for: ChatAgents.codex), [])
    let noNode = ACPHostCheck.problems(in: "node=missing\nopencode=ok\n")
    XCTAssertEqual(ACPHostCheck.relevant(noNode, for: ChatAgents.codex), [.nodeMissing])
    XCTAssertEqual(ACPHostCheck.relevant(noNode, for: ChatAgents.opencode), [])
    XCTAssertEqual(ACPHostCheck.problems(in: Self.ours + "opencode=ok\n"), [])
    XCTAssertEqual(
      ACPHostCheck.message(for: [.opencodeMissing], host: "box"),
      "Install opencode on box (opencode.ai), or check it is on the PATH of a login shell.")
    XCTAssertTrue(ACPHostCheck.script.contains("$HOME/.opencode/bin/opencode"))
  }

  func test_starting_an_opencode_chat_stops_when_opencode_is_missing() async {
    let report = Self.ours + "opencode=missing\n"
    let opencode = await ChatRoute.start(cwdText: "/srv", host: "box", agent: ChatAgents.opencode) { _ in report }
    XCTAssertEqual(
      opencode, .failed("Install opencode on box (opencode.ai), or check it is on the PATH of a login shell."))
    let claude = await ChatRoute.start(cwdText: "/srv", host: "box") { command in
      command == ACPHostCheck.command ? report : "/home/dev"
    }
    guard case .ready = claude else { return XCTFail("\(claude)") }
  }

  func test_the_command_runs_a_quoted_posix_script_whatever_the_login_shell() {
    XCTAssertFalse(ACPHostCheck.script.contains("'"), "the script must survive single-quote wrapping")
    XCTAssertEqual(ACPHostCheck.command, "sh -c " + shellQuote(ACPHostCheck.script))
    XCTAssertTrue(ACPHostCheck.script.contains("command -v npx"))
    XCTAssertTrue(ACPHostCheck.script.contains("tether version --json"))
    XCTAssertTrue(ACPHostCheck.script.contains("timeout 5"))
    XCTAssertTrue(ACPHostCheck.script.hasPrefix("PATH=\"$HOME/.local/bin:$PATH\"; export PATH"))
  }

  func test_the_report_parses_into_problems() {
    XCTAssertEqual(ACPHostCheck.problems(in: Self.ours), [])
    XCTAssertEqual(
      ACPHostCheck.problems(in: "tether=found\nversion={\"name\":\"tether\",\"version\":\"dev\",\"protocol\":7}\nnode=ok"), [],
      "a newer protocol is fine")
    XCTAssertEqual(ACPHostCheck.problems(in: "tether=missing\nnode=ok\n"), [.tetherMissing])
    XCTAssertEqual(
      ACPHostCheck.problems(in: "tether=found\nversion=\nnode=ok\n"), [.tetherForeign],
      "no JSON: the retired v4 server")
    XCTAssertEqual(
      ACPHostCheck.problems(in: "tether=found\nversion=tether — persistent remote-shell server (v4.9)\nnode=ok\n"),
      [.tetherForeign])
    XCTAssertEqual(
      ACPHostCheck.problems(in: "tether=found\nversion={\"name\":\"other\",\"protocol\":9}\n"), [.tetherForeign],
      "valid JSON for another tool is still not ours")
    XCTAssertEqual(
      ACPHostCheck.problems(in: "tether=found\nversion={\"name\":\"tether\",\"version\":\"x\",\"protocol\":0}\nnode=missing\n"),
      [.tetherOutdated, .nodeMissing])
    XCTAssertEqual(
      ACPHostCheck.problems(in: "tether=found\nversion={\"name\":\"tether\",\"version\":\"x\"}\n"), [.tetherOutdated],
      "no protocol number reads as too old")
    XCTAssertEqual(ACPHostCheck.problems(in: "node=missing"), [.nodeMissing])
    XCTAssertEqual(ACPHostCheck.problems(in: "  tether=missing \r\n"), [.tetherMissing])
    XCTAssertEqual(ACPHostCheck.problems(in: ""), [], "a host that said nothing is not blamed")
    XCTAssertEqual(ACPHostCheck.problems(in: "welcome back!\n" + Self.ours), [])
  }

  func test_each_problem_has_a_plain_message_naming_the_host() {
    XCTAssertNil(ACPHostCheck.message(for: [], host: "box"))
    XCTAssertEqual(
      ACPHostCheck.message(for: [.tetherMissing], host: "box"),
      "Install tether on box (install.sh). tether-notify is now called tether.")
    XCTAssertEqual(
      ACPHostCheck.message(for: [.tetherForeign], host: "box"),
      "Another program named tether is installed on box (the old Tether server). Run install.sh there to replace it.")
    XCTAssertEqual(ACPHostCheck.message(for: [.tetherOutdated], host: "box"), "Update tether on box (install.sh).")
    XCTAssertEqual(ACPHostCheck.message(for: [.nodeMissing], host: "box"), "Node.js is required on box.")
    XCTAssertEqual(
      ACPHostCheck.message(for: [.tetherMissing, .nodeMissing], host: "box"),
      "Install tether on box (install.sh). tether-notify is now called tether. Node.js is required on box.")
  }

  func test_starting_a_chat_stops_before_spawning_on_a_host_that_fails_a_check() async {
    var commands: [String] = []
    let start = await ChatRoute.start(cwdText: "/srv", host: "box") { command in
      commands.append(command)
      return "tether=found\nversion={\"name\":\"tether\",\"protocol\":0}\nnode=ok\n"
    }
    XCTAssertEqual(start, .failed("Update tether on box (install.sh)."))
    XCTAssertEqual(commands, [ACPHostCheck.command], "nothing else runs, and no agent is spawned")

    let node = await ChatRoute.start(cwdText: "/srv", host: "box") { _ in
      "tether=found\nversion={\"name\":\"tether\",\"protocol\":1}\nnode=missing\n"
    }
    XCTAssertEqual(node, .failed("Node.js is required on box."))
  }

  func test_a_ready_host_gets_a_route_and_an_unreachable_check_does_not_block() async {
    let ready = await ChatRoute.start(cwdText: "~/p", host: "box") { command in
      command == ACPHostCheck.command ? Self.ours : "/home/dev"
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
      if command == ACPHostCheck.command { return Self.ours }
      throw SSHConnectError.transport("down")
    }
    XCTAssertEqual(noHome, .failed("Couldn't read the host's home folder."))
  }

  func test_the_chat_list_shows_the_reason_under_the_start_button_and_clears_it() async {
    let report = LockedBox("tether=found\nversion={\"name\":\"tether\",\"protocol\":1}\nnode=missing\n")
    let model = ChatListModel(hostName: "box") { command in
      command == ACPHostCheck.command ? report.value : "/home/dev"
    }
    let blocked = await model.newRoute(cwdText: "/srv")
    XCTAssertNil(blocked)
    XCTAssertEqual(model.startError, "Node.js is required on box.")
    XCTAssertNil(model.errorMessage, "a normal row, not the generic alert")

    report.value = Self.ours
    let route = await model.newRoute(cwdText: "/srv")
    XCTAssertNotNil(route)
    XCTAssertNil(model.startError)
  }

  func test_a_host_with_a_too_old_tether_explains_itself_in_the_list() async {
    let model = ChatListModel(hostName: "box") { _ in "tether: unknown command \"acp\"\nusage: ...\n" }
    await model.refresh()
    guard case let .failed(message) = model.load else { return XCTFail() }
    XCTAssertTrue(message.hasPrefix("Update tether on box."))
  }
}
