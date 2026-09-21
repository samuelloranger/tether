import Foundation
import XCTest
@testable import TetherKit

final class ZmxSessionListTests: XCTestCase {
  func test_parses_tab_separated_key_value_rows() {
    let out = """
        name=App terminal ssh\tpid=2167034\tclients=0\tcreated=1789875110\tcwd=file://homelab/home/samuelloranger
      name=samuelloranger-2\tpid=3798443\tclients=1\tcreated=1789788674\tcwd=file://homelab/home/sam/proj
    """
    let sessions = ZmxSession.parse(out)
    XCTAssertEqual(sessions.count, 2)
    XCTAssertEqual(sessions[0].name, "App terminal ssh") // names may contain spaces
    XCTAssertEqual(sessions[0].pid, 2167034)
    XCTAssertEqual(sessions[0].clients, 0)
    XCTAssertEqual(sessions[0].created, 1789875110)
    XCTAssertEqual(sessions[0].cwd, "file://homelab/home/samuelloranger")
    XCTAssertEqual(sessions[1].name, "samuelloranger-2")
    XCTAssertEqual(sessions[1].clients, 1)
  }

  func test_display_cwd_strips_the_file_url_host_prefix() {
    let sessions = ZmxSession.parse("name=x\tpid=1\tclients=0\tcreated=0\tcwd=file://homelab/home/sam/proj")
    XCTAssertEqual(sessions.first?.displayCwd, "/home/sam/proj")
  }

  func test_empty_output_yields_no_sessions() {
    XCTAssertTrue(ZmxSession.parse("").isEmpty)
    XCTAssertTrue(ZmxSession.parse("\n  \n").isEmpty)
  }

  func test_rows_without_a_name_are_skipped() {
    let sessions = ZmxSession.parse("pid=1\tclients=0\nname=ok\tpid=2\tclients=0\tcreated=0\tcwd=x")
    XCTAssertEqual(sessions.map(\.name), ["ok"])
  }
}
