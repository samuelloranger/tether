import UserNotifications
import XCTest
@testable import TetherKit

@MainActor
final class NotificationActionsTests: XCTestCase {
  private let userInfo: [AnyHashable: Any] = [
    "link": "tether://session/work?host=devbox",
    "agentState": "waiting",
    "agentVersion": "3f9a0c",
  ]
  private let expect = AgentExpectation(state: "waiting", version: "3f9a0c")

  func test_waiting_offers_approve_deny_and_reply_and_done_offers_reply() {
    let categories = Dictionary(uniqueKeysWithValues: NotificationActions.categories().map { ($0.identifier, $0) })
    XCTAssertEqual(
      categories[NotificationActions.waitingCategory]?.actions.map(\.identifier),
      [NotificationActions.approveAction, NotificationActions.denyAction, NotificationActions.replyAction]
    )
    XCTAssertEqual(categories[NotificationActions.doneCategory]?.actions.map(\.identifier), [NotificationActions.replyAction])
    XCTAssertEqual(Set(categories.keys), NotificationActions.categoryIdentifiers)
  }

  func test_every_action_needs_an_unlocked_phone_and_only_answer_opens_the_app() {
    let all = NotificationActions.categories().flatMap(\.actions)
      + NotificationActions.questionCategory(version: "v1", options: ["a", "b"]).actions
    for action in all {
      XCTAssertTrue(action.options.contains(.authenticationRequired), action.identifier)
      XCTAssertEqual(action.options.contains(.foreground), action.identifier == NotificationActions.answerAction, action.identifier)
    }
  }

  // MARK: - questions

  private let questionInfo: [AnyHashable: Any] = [
    "link": "tether://session/work?host=devbox",
    "agentState": "waiting",
    "agentVersion": "v7",
  ]

  func test_a_question_push_offers_its_options_then_answer() {
    let category = NotificationActions.questionCategory(version: "v7", options: ["Postgres", "SQLite"])
    XCTAssertEqual(category.identifier, "tether.agent.question.v7")
    XCTAssertEqual(category.actions.map(\.identifier),
                   ["tether.action.option.1", "tether.action.option.2", NotificationActions.answerAction])
    XCTAssertEqual(category.actions.map(\.title), ["Postgres", "SQLite", "Answer…"])
    let plain = NotificationActions.categories().first { $0.identifier == NotificationActions.questionCategory }
    XCTAssertEqual(plain?.actions.map(\.identifier), [NotificationActions.answerAction])
  }

  func test_launch_categories_keep_per_push_question_categories() {
    let perPush = NotificationActions.questionCategory(version: "v7", options: ["a", "b"])
    let stranger = UNNotificationCategory(identifier: "other", actions: [], intentIdentifiers: [])
    let merged = Set(NotificationActions.launchCategories(existing: [perPush, stranger]).map(\.identifier))
    XCTAssertTrue(merged.contains("tether.agent.question.v7"))
    XCTAssertFalse(merged.contains("other"))
    XCTAssertTrue(NotificationActions.categoryIdentifiers.isSubset(of: merged))
  }

  func test_an_option_button_answers_with_its_index() {
    XCTAssertEqual(
      NotificationActions.attempt(actionIdentifier: "tether.action.option.2", text: nil, userInfo: questionInfo),
      .answer(NotificationActionRequest(
        link: SessionDeepLink(sessionId: "work", identityName: "devbox"),
        expect: AgentExpectation(state: "waiting", version: "v7"), input: .option(2)
      ))
    )
    XCTAssertNil(NotificationActions.attempt(actionIdentifier: "tether.action.option.0", text: nil, userInfo: questionInfo))
    XCTAssertNil(NotificationActions.attempt(actionIdentifier: "tether.action.option.x", text: nil, userInfo: questionInfo))
  }

  func test_answer_opens_the_question_instead_of_sending() {
    XCTAssertEqual(
      NotificationActions.attempt(actionIdentifier: NotificationActions.answerAction, text: nil, userInfo: questionInfo),
      .openQuestion(
        link: SessionDeepLink(sessionId: "work", identityName: "devbox"),
        expect: AgentExpectation(state: "waiting", version: "v7")
      )
    )
  }

  func test_option_and_answers_commands() {
    let link = SessionDeepLink(sessionId: "work", identityName: "devbox")
    let expect = AgentExpectation(state: "waiting", version: "v7")
    XCTAssertEqual(
      NotificationActions.command(notify: "tn", request: NotificationActionRequest(link: link, expect: expect, input: .option(2))),
      "tn answer --session 'work' --state 'waiting' --version 'v7' --option 2"
    )
    let answers = ["Which color?": "Blue", "Which fruits?": "Apple, Pear"]
    let json = #"{"Which color?":"Blue","Which fruits?":"Apple, Pear"}"#
    XCTAssertEqual(
      NotificationActions.command(notify: "tn", request: NotificationActionRequest(link: link, expect: expect, input: .answers(answers))),
      "tn answer --session 'work' --state 'waiting' --version 'v7' --answers '\(Data(json.utf8).base64EncodedString())'"
    )
  }

  func test_approve_is_return_and_deny_is_escape() {
    XCTAssertEqual(NotificationActions.input(actionIdentifier: NotificationActions.approveAction, text: nil), .keys("\r"))
    XCTAssertEqual(NotificationActions.input(actionIdentifier: NotificationActions.denyAction, text: nil), .keys("\u{1b}"))
  }

  func test_a_reply_is_one_trimmed_line() {
    XCTAssertEqual(
      NotificationActions.input(actionIdentifier: NotificationActions.replyAction, text: "  run the tests\nthen push  "),
      .line("run the tests then push")
    )
  }

  func test_a_complete_push_becomes_an_answer_with_its_expected_state() {
    XCTAssertEqual(
      NotificationActions.attempt(actionIdentifier: NotificationActions.approveAction, text: nil, userInfo: userInfo),
      .answer(NotificationActionRequest(
        link: SessionDeepLink(sessionId: "work", identityName: "devbox"), expect: expect, input: .keys("\r")
      ))
    )
    var noVersion = userInfo
    noVersion["agentVersion"] = ""
    XCTAssertNil(NotificationActions.expectation(from: noVersion))
  }

  func test_a_push_missing_its_link_or_state_is_reported_not_silently_dropped() {
    for missing in ["link", "agentState", "agentVersion"] {
      var info = userInfo
      info[missing] = nil
      guard case .unanswerable = NotificationActions.attempt(
        actionIdentifier: NotificationActions.approveAction, text: nil, userInfo: info
      ) else { return XCTFail("missing \(missing) still answered") }
    }
    guard case .unanswerable = NotificationActions.attempt(
      actionIdentifier: NotificationActions.replyAction, text: "   ", userInfo: userInfo
    ) else { return XCTFail("an empty reply still answered") }
  }

  func test_a_flag_like_session_name_is_never_answered() {
    var info = userInfo
    info["link"] = "tether://session/--help?host=devbox"
    guard case .unanswerable = NotificationActions.attempt(
      actionIdentifier: NotificationActions.approveAction, text: nil, userInfo: info
    ) else { return XCTFail("--help was answered") }
  }

  func test_an_overlong_reply_is_refused_with_a_reason() {
    let long = String(repeating: "x", count: NotificationActions.maxReplyLength + 1)
    guard case let .unanswerable(_, reason) = NotificationActions.attempt(
      actionIdentifier: NotificationActions.replyAction, text: long, userInfo: userInfo
    ) else { return XCTFail("an overlong reply was answered") }
    XCTAssertTrue(reason.contains("\(NotificationActions.maxReplyLength)"), reason)
  }

  func test_other_actions_are_not_ours() {
    XCTAssertNil(NotificationActions.attempt(actionIdentifier: "other", text: nil, userInfo: userInfo))
  }

  func test_the_command_passes_input_as_base64_to_tether_notify() {
    let request = NotificationActionRequest(
      link: SessionDeepLink(sessionId: "my 'box'", identityName: "devbox"), expect: expect,
      input: .line("it's $(rm -rf ~)")
    )
    let encoded = Data("it's $(rm -rf ~)".utf8).base64EncodedString()
    XCTAssertEqual(
      NotificationActions.command(notify: "tn", request: request),
      "tn answer --session 'my '\"'\"'box'\"'\"'' --state 'waiting' --version '3f9a0c' --input '\(encoded)' --submit"
    )
  }

  // MARK: - runner

  private func model(_ machines: [(name: String, host: String)] = [("devbox", "10.0.0.2")]) -> HomeModel {
    let suite = "tether.notification-actions.tests"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let secrets = InMemorySSHSecrets()
    let model = HomeModel(
      profileStore: SSHProfileStore(storage: UserDefaultsSSHStore(defaults: defaults)),
      vault: SSHKeyVault(storage: UserDefaultsSSHStore(defaults: defaults), secrets: secrets),
      secrets: secrets
    )
    for machine in machines {
      model.addServer(name: machine.name, host: machine.host, port: 22, username: "me", auth: .password, password: "pw")
    }
    return model
  }

  private var approve: NotificationActionRequest {
    NotificationActionRequest(link: SessionDeepLink(sessionId: "work", identityName: "devbox"), expect: expect, input: .keys("\r"))
  }

  func test_the_runner_answers_through_tether_notify_on_the_one_matching_machine() async {
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
    XCTAssertTrue(commands.value.first?.hasPrefix("~/.local/bin/tether-notify answer --session 'work' ") == true)
  }

  func test_a_label_two_machines_answer_to_is_refused_without_dialing() async {
    let dialed = LockedBox(false)
    let runner = NotificationActionRunner(model: model([("devbox", "10.0.0.2"), ("work", "devbox.lan")])) { _, _, _ in
      dialed.value = true
      return "__tether_sent=0"
    }
    let failure = await runner.run(approve)
    XCTAssertEqual(failure, "“devbox” matches 2 saved machines; open the session to answer.")
    XCTAssertFalse(dialed.value)
  }

  func test_an_unknown_machine_is_refused_without_dialing() async {
    let dialed = LockedBox(false)
    let runner = NotificationActionRunner(model: model([("elsewhere", "10.0.0.9")])) { _, _, _ in
      dialed.value = true
      return ""
    }
    let failure = await runner.run(approve)
    XCTAssertNotNil(failure)
    XCTAssertFalse(dialed.value)
  }

  func test_host_answers_map_to_clear_messages() {
    let failure = { NotificationActionRunner.failure(output: $0, session: "work", machine: "devbox") }
    XCTAssertNil(failure("__tether_sent=0\n"))
    XCTAssertEqual(failure("tether-notify: the agent has moved on\n__tether_sent=3\n"),
                   "The agent in “work” has moved on; nothing was sent.")
    XCTAssertEqual(failure("typed\n__tether_sent=4\n"),
                   "The reply was typed in “work”, but the agent moved on before it was submitted.")
    XCTAssertEqual(failure("zsh: no such file\n__tether_sent=127\n"), "Update tether-notify on devbox to answer notifications.")
    XCTAssertEqual(failure("usage…\n__tether_sent=2\n"), "Update tether-notify on devbox to answer notifications.")
    XCTAssertEqual(failure("tether-notify: zmx send: exit status 1\n__tether_sent=1\n"), "tether-notify: zmx send: exit status 1")
    XCTAssertEqual(failure(""), "No answer from devbox.")
  }

  func test_a_second_action_waits_for_a_dial_the_deadline_gave_up_on() async {
    let release = LockedBox<CheckedContinuation<Void, Never>?>(nil)
    let dials = LockedBox(0)
    let runner = NotificationActionRunner(model: model(), timeout: .milliseconds(100)) { _, _, _ in
      dials.update { $0 += 1 }
      await withCheckedContinuation { release.value = $0 }
      return "__tether_sent=0"
    }
    let first = await runner.run(approve)
    XCTAssertEqual(first, SSHConnectError.commandTimedOut.errorDescription)
    let second = await runner.run(approve)
    XCTAssertEqual(second, "The previous action is still being sent; try again in a moment.")
    XCTAssertEqual(dials.value, 1, "a second thread was started while the first was stuck")
    release.value?.resume()
    try? await Task.sleep(for: .milliseconds(100))
    let third = await runner.run(approve)
    XCTAssertEqual(third, SSHConnectError.commandTimedOut.errorDescription)
    XCTAssertEqual(dials.value, 2)
    release.value?.resume()
  }

  func test_a_dial_that_never_returns_stops_blocking_after_a_while() async {
    let clock = LockedBox(Date(timeIntervalSince1970: 1000))
    let runner = NotificationActionRunner(
      model: model(), timeout: .milliseconds(50), abandonAfter: 120, now: { clock.value }
    ) { _, _, _ in
      await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
      return ""
    }
    _ = await runner.run(approve)
    let blocked = await runner.run(approve)
    XCTAssertEqual(blocked, "The previous action is still being sent; try again in a moment.")
    clock.value = clock.value.addingTimeInterval(121)
    let later = await runner.run(approve)
    XCTAssertEqual(later, SSHConnectError.commandTimedOut.errorDescription, "an abandoned dial still blocks actions")
  }

  func test_the_deadline_holds_even_when_the_work_ignores_cancellation() async {
    // Stands in for a blocked getaddrinfo: nothing ever resumes it.
    let runner = NotificationActionRunner(model: model(), timeout: .milliseconds(200)) { _, _, _ in
      await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
      return ""
    }
    let started = Date()
    let failure = await runner.run(approve)
    XCTAssertEqual(failure, SSHConnectError.commandTimedOut.errorDescription)
    XCTAssertLessThan(Date().timeIntervalSince(started), 2)
  }

  func test_the_runner_reads_the_pending_question() async {
    let commands = LockedBox<[String]>([])
    let runner = NotificationActionRunner(model: model()) { _, _, command in
      commands.value.append(command)
      return #"{"session":"work","state":"waiting","version":"v7","kind":"question","questions":[{"question":"Which DB?","header":"DB","multiSelect":false,"options":[{"label":"Postgres","description":"server"},{"label":"SQLite"}]}]}"#
        + "\n__tether_sent=0\n"
    }
    let link = SessionDeepLink(sessionId: "work", identityName: "devbox")
    guard case let .success(pending) = await runner.pendingQuestions(for: link) else { return XCTFail("not loaded") }
    XCTAssertEqual(pending.version, "v7")
    XCTAssertEqual(pending.questions.first?.options.map(\.label), ["Postgres", "SQLite"])
    XCTAssertEqual(pending.questions.first?.options.first?.description, "server")
    XCTAssertTrue(commands.value.first?.hasPrefix("~/.local/bin/tether-notify pending --session 'work'") == true)
  }

  func test_a_question_that_moved_on_says_so() async {
    let runner = NotificationActionRunner(model: model()) { _, _, _ in "nothing\n__tether_sent=3\n" }
    let result = await runner.pendingQuestions(for: SessionDeepLink(sessionId: "work", identityName: "devbox"))
    guard case let .failure(error) = result else { return XCTFail("loaded") }
    XCTAssertEqual(error.message, "The question in “work” was already answered or has moved on.")
  }
}
