import UserNotifications
import XCTest
@testable import TetherKit

@MainActor
final class NotificationActionsTests: XCTestCase {
  private let link: [AnyHashable: Any] = ["link": "tether://session/work?host=devbox"]

  func test_waiting_offers_approve_deny_and_reply_and_done_offers_reply() {
    let categories = Dictionary(uniqueKeysWithValues: NotificationActions.categories().map { ($0.identifier, $0) })
    XCTAssertEqual(
      categories[NotificationActions.waitingCategory]?.actions.map(\.identifier),
      [NotificationActions.approveAction, NotificationActions.denyAction, NotificationActions.replyAction]
    )
    XCTAssertEqual(categories[NotificationActions.doneCategory]?.actions.map(\.identifier), [NotificationActions.replyAction])
    XCTAssertEqual(Set(categories.keys), NotificationActions.categoryIdentifiers)
  }

  func test_every_action_needs_an_unlocked_phone_and_none_opens_the_app() {
    for action in NotificationActions.categories().flatMap(\.actions) {
      XCTAssertTrue(action.options.contains(.authenticationRequired), action.identifier)
      XCTAssertFalse(action.options.contains(.foreground), action.identifier)
    }
  }

  func test_approve_is_return_and_deny_is_escape() {
    XCTAssertEqual(NotificationActions.input(actionIdentifier: NotificationActions.approveAction, text: nil), .keys("\r"))
    XCTAssertEqual(NotificationActions.input(actionIdentifier: NotificationActions.denyAction, text: nil), .keys("\u{1b}"))
  }

  func test_a_reply_is_one_trimmed_line_and_an_empty_one_sends_nothing() {
    XCTAssertEqual(
      NotificationActions.input(actionIdentifier: NotificationActions.replyAction, text: "  run the tests\nthen push  "),
      .line("run the tests then push")
    )
    XCTAssertNil(NotificationActions.input(actionIdentifier: NotificationActions.replyAction, text: "   "))
    XCTAssertNil(NotificationActions.input(actionIdentifier: NotificationActions.replyAction, text: nil))
  }

  func test_an_unknown_action_or_a_push_without_a_tether_link_makes_no_request() {
    XCTAssertNil(NotificationActions.request(actionIdentifier: "other", text: nil, userInfo: link))
    XCTAssertNil(NotificationActions.request(
      actionIdentifier: NotificationActions.approveAction, text: nil, userInfo: ["link": "https://example.com"]
    ))
    XCTAssertEqual(
      NotificationActions.request(actionIdentifier: NotificationActions.approveAction, text: nil, userInfo: link),
      NotificationActionRequest(link: SessionDeepLink(sessionId: "work", identityName: "devbox"), input: .keys("\r"))
    )
  }

  func test_keys_are_sent_as_octal_escapes_in_one_write() {
    XCTAssertEqual(
      NotificationActions.command(zmx: "zmx", session: "work", input: .keys("\u{1b}")),
      #"zmx send 'work' "$(printf '\033')""#
    )
  }

  func test_a_line_is_quoted_then_submitted_in_a_second_write() {
    XCTAssertEqual(
      NotificationActions.command(zmx: "zmx", session: "my 'box'", input: .line("it's $HOME")),
      #"zmx send 'my '"'"'box'"'"'' 'it'"'"'s $HOME' && sleep 0.3 && zmx send 'my '"'"'box'"'"'' "$(printf '\015')""#
    )
  }

  // MARK: - runner

  private func model(host: String = "devbox") -> HomeModel {
    let suite = "tether.notification-actions.tests"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let secrets = InMemorySSHSecrets()
    let model = HomeModel(
      profileStore: SSHProfileStore(storage: UserDefaultsSSHStore(defaults: defaults)),
      vault: SSHKeyVault(storage: UserDefaultsSSHStore(defaults: defaults), secrets: secrets),
      secrets: secrets
    )
    model.addServer(name: host, host: "10.0.0.2", port: 22, username: "me", auth: .password, password: "pw")
    return model
  }

  private let approve = NotificationActionRequest(
    link: SessionDeepLink(sessionId: "work", identityName: "devbox"), input: .keys("\r")
  )

  func test_the_runner_sends_to_the_linked_session_on_the_matching_machine() async {
    let commands = LockedBox<[String]>([])
    let hosts = LockedBox<[String]>([])
    let runner = NotificationActionRunner(model: model()) { config, _, command in
      commands.value.append(command)
      hosts.value.append(config.host)
      return "__tether_sent=0\n"
    }
    let failure = await runner.run(approve)
    XCTAssertNil(failure)
    XCTAssertEqual(hosts.value, ["10.0.0.2"])
    XCTAssertEqual(commands.value.count, 1)
    XCTAssertTrue(commands.value[0].hasPrefix("~/.local/bin/zmx send 'work' "), commands.value[0])
  }

  func test_the_runner_reports_an_unknown_machine_without_dialing() async {
    let dialed = LockedBox(false)
    let runner = NotificationActionRunner(model: model(host: "elsewhere")) { _, _, _ in
      dialed.value = true
      return ""
    }
    let failure = await runner.run(approve)
    XCTAssertNotNil(failure)
    XCTAssertFalse(dialed.value)
  }

  func test_the_runner_reports_a_zmx_failure_and_an_ssh_error() async {
    let zmxFailed = NotificationActionRunner(model: model()) { _, _, _ in "session work is unresponsive\n__tether_sent=1\n" }
    let failure = await zmxFailed.run(approve)
    XCTAssertEqual(failure, "zmx could not reach session “work” on devbox.")

    let sshFailed = NotificationActionRunner(model: model()) { _, _, _ in throw SSHConnectError.commandTimedOut }
    let sshFailure = await sshFailed.run(approve)
    XCTAssertEqual(sshFailure, SSHConnectError.commandTimedOut.errorDescription)
  }
}
