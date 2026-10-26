import UserNotifications
import XCTest
@testable import TetherKit

@MainActor
final class ACPPermissionPushTests: XCTestCase {
  private let userInfo: [AnyHashable: Any] = [
    "link": "tether://chat/chat-ab12?host=devbox",
    "agentState": "waiting",
    "agentVersion": "h1",
    "acpName": "chat-ab12",
    "acpRequestId": "0",
    "acpOptions": ["Yes", "Yes, allow all edits during this session", "No"],
    "acpOptionIds": ["allow-once", "allow-with-updates", "reject"],
    "acpOptionKinds": ["allow_once", "allow_always", "reject_once"],
  ]

  func test_a_push_is_parsed_into_its_chat_request_and_options() throws {
    let push = try XCTUnwrap(ACPPermissionPush(userInfo: userInfo))
    XCTAssertEqual(push.chat, ChatDeepLink(chatName: "chat-ab12", identityName: "devbox"))
    XCTAssertEqual(push.acp, "chat-ab12")
    XCTAssertEqual(push.requestId, "0")
    XCTAssertEqual(push.options.map(\.id), ["allow-once", "allow-with-updates", "reject"])
    XCTAssertEqual(push.options.map(\.isReject), [false, false, true])
  }

  func test_a_push_missing_a_piece_is_not_answerable() {
    for key in ["link", "acpName", "acpRequestId", "acpOptions", "acpOptionIds"] {
      var broken = userInfo
      broken[key] = nil
      XCTAssertNil(ACPPermissionPush(userInfo: broken), key)
    }
    var mismatched = userInfo
    mismatched["acpOptionIds"] = ["allow-once"]
    XCTAssertNil(ACPPermissionPush(userInfo: mismatched))
    var tooMany = userInfo
    tooMany["acpOptions"] = ["a", "b", "c", "d", "e"]
    tooMany["acpOptionIds"] = ["a", "b", "c", "d", "e"]
    XCTAssertNil(ACPPermissionPush(userInfo: tooMany))
    var flag = userInfo
    flag["acpName"] = "--cancel"
    XCTAssertNil(ACPPermissionPush(userInfo: flag))
  }

  func test_the_per_push_category_has_one_action_per_option_and_only_a_reject_is_destructive() {
    let category = ACPPermissionPush.notificationCategory(
      version: "h1", labels: ["Yes", "Always", "No"], kinds: ["allow_once", "allow_always", "reject_once"])
    XCTAssertEqual(category.identifier, "tether.acp.permission.h1")
    XCTAssertEqual(category.actions.map(\.identifier),
                   ["tether.action.option.1", "tether.action.option.2", "tether.action.option.3"])
    XCTAssertEqual(category.actions.map(\.title), ["Yes", "Always", "No"])
    XCTAssertEqual(category.actions.map { $0.options.contains(.destructive) }, [false, false, true])
    for action in category.actions {
      XCTAssertTrue(action.options.contains(.authenticationRequired))
      XCTAssertFalse(action.options.contains(.foreground))
    }
  }

  func test_the_static_categories_exist_and_carry_no_actions() {
    let categories = Dictionary(uniqueKeysWithValues: NotificationActions.categories().map { ($0.identifier, $0) })
    XCTAssertEqual(categories["tether.acp.permission"]?.actions.count, 0)
    XCTAssertEqual(categories["tether.acp.done"]?.actions.count, 0)
  }

  func test_launch_categories_keep_per_push_acp_categories() {
    let perPush = ACPPermissionPush.notificationCategory(version: "h1", labels: ["a", "b"], kinds: [])
    let merged = Set(NotificationActions.launchCategories(existing: [perPush]).map(\.identifier))
    XCTAssertTrue(merged.contains("tether.acp.permission.h1"))
  }

  func test_a_button_tap_answers_with_that_options_id() {
    XCTAssertEqual(
      NotificationActions.attempt(actionIdentifier: "tether.action.option.3", text: nil, userInfo: userInfo),
      .answerACP(ACPAnswerRequest(
        chat: ChatDeepLink(chatName: "chat-ab12", identityName: "devbox"), acp: "chat-ab12", requestId: "0",
        optionId: "reject", optionLabel: "No"))
    )
    XCTAssertNil(NotificationActions.attempt(actionIdentifier: "tether.action.option.4", text: nil, userInfo: userInfo))
    XCTAssertNil(NotificationActions.attempt(actionIdentifier: "tether.action.option.0", text: nil, userInfo: userInfo))
  }

  func test_the_command_quotes_every_value() {
    let notify = NotificationActionRunner.notify
    let plain = ACPAnswerRequest(
      chat: ChatDeepLink(chatName: "c", identityName: "h"), acp: "chat-ab12", requestId: "0",
      optionId: "allow-once", optionLabel: "Yes")
    XCTAssertEqual(
      ACPAnswerCommand.command(notify: notify, request: plain),
      "~/.local/bin/tether acp answer 'chat-ab12' --request '0' --option 'allow-once'")
    let hostile = ACPAnswerRequest(
      chat: ChatDeepLink(chatName: "c", identityName: "h"), acp: "it's; rm -rf /", requestId: "\"a b\"; id",
      optionId: "x' y;$(id)", optionLabel: "Yes")
    XCTAssertEqual(
      ACPAnswerCommand.command(notify: notify, request: hostile),
      "~/.local/bin/tether acp answer 'it'\"'\"'s; rm -rf /' --request '\"a b\"; id' --option 'x'\"'\"' y;$(id)'")
  }

  private let questionInfo: [AnyHashable: Any] = [
    "link": "tether://chat/chat-ab12?host=devbox",
    "agentState": "waiting",
    "agentVersion": "q1",
    "acpName": "chat-ab12",
    "acpRequestId": "3",
    "acpOptions": ["red", "green", "blue"],
    "acpOptionIds": ["red", "green", "it's \"blue\"; x"],
    "acpOptionKinds": ["choice", "choice", "choice"],
    "elicitation": true,
  ]

  func test_a_question_push_is_answered_by_a_button_and_says_what_was_chosen() throws {
    let push = try XCTUnwrap(ACPPermissionPush(userInfo: questionInfo))
    XCTAssertEqual(push.options.map(\.isChoice), [true, true, true])
    XCTAssertEqual(push.options.map(\.isReject), [false, false, false])
    XCTAssertEqual(
      NotificationActions.attempt(actionIdentifier: "tether.action.option.2", text: nil, userInfo: questionInfo),
      .answerACP(ACPAnswerRequest(
        chat: ChatDeepLink(chatName: "chat-ab12", identityName: "devbox"), acp: "chat-ab12", requestId: "3",
        optionId: "green", optionLabel: "green", isChoice: true)))
    let permission = try XCTUnwrap(ACPPermissionPush(userInfo: userInfo))
    XCTAssertEqual(permission.options.map(\.isChoice), [false, false, false])

    let category = ACPPermissionPush.notificationCategory(
      version: "q1", labels: ["red", "green", "blue"], kinds: ["choice", "choice", "choice"])
    XCTAssertEqual(category.actions.map(\.title), ["red", "green", "blue"])
    XCTAssertEqual(category.actions.map { $0.options.contains(.destructive) }, [false, false, false])
  }

  func test_a_question_answer_command_quotes_a_value_with_quotes_spaces_and_semicolons() {
    let value = "it's \"two words\"; rm -rf ~ $(id)"
    let request = ACPAnswerRequest(
      chat: ChatDeepLink(chatName: "c", identityName: "h"), acp: "chat-ab12", requestId: "3",
      optionId: value, optionLabel: value, isChoice: true)
    XCTAssertEqual(
      ACPAnswerCommand.command(notify: "tn", request: request),
      "tn acp answer 'chat-ab12' --request '3' --option 'it'\"'\"'s \"two words\"; rm -rf ~ $(id)'")
  }

  func test_the_answers_command_quotes_the_name() {
    XCTAssertEqual(
      ACPAnswerCommand.answersCommand(notify: "tn", acp: "a b;c"), "tn acp answers 'a b;c'")
  }

  func test_exit_codes_become_outcomes() {
    func outcome(_ text: String) -> ACPAnswerOutcome { ACPAnswerOutcome.interpret(output: text, machine: "box") }
    XCTAssertEqual(outcome("__tether_sent=0\n"), .answered)
    XCTAssertEqual(outcome("not outstanding\n__tether_sent=3\n"), .alreadyAnswered)
    XCTAssertEqual(outcome("sh: tether: not found\n__tether_sent=127\n"), .failed("Update tether on box to answer chats."))
    XCTAssertEqual(outcome("boom\n__tether_sent=1\n"), .failed("boom"))
    XCTAssertEqual(outcome(""), .failed("No answer from box."))
  }

  func test_answers_output_maps_request_ids_and_ignores_garbage() {
    XCTAssertEqual(
      ACPAnswerCommand.parseAnswers("motd\n{\"0\":\"allow-once\",\"\\\"abc\\\"\":\"cancelled\"}\n"),
      [.int(0): "allow-once", .string("abc"): "cancelled"])
    XCTAssertEqual(ACPAnswerCommand.parseAnswers("{}"), [:])
    XCTAssertEqual(ACPAnswerCommand.parseAnswers("Usage: acp answers"), [:])
    XCTAssertEqual(ACPAnswerCommand.parseAnswers("{\"0\": 5}"), [:])
    XCTAssertEqual(ACPAnswerCommand.parseAnswers(""), [:])
  }

  // MARK: - links

  func test_a_chat_link_parses_and_a_session_link_does_not() {
    XCTAssertEqual(
      DeepLinkCoordinator.parseChat("tether://chat/chat-ab12?host=dev%20box"),
      ChatDeepLink(chatName: "chat-ab12", identityName: "dev box"))
    XCTAssertNil(DeepLinkCoordinator.parseChat("tether://session/work?host=devbox"))
    XCTAssertNil(DeepLinkCoordinator.parse("tether://chat/chat-ab12?host=devbox"))
    XCTAssertNil(DeepLinkCoordinator.parseChat("tether://chat/chat-ab12"))
    XCTAssertNil(DeepLinkCoordinator.parseChat("https://chat/x?host=y"))
  }

  func test_a_chat_link_routes_like_a_session_link() {
    let desk = SSHHostProfile(id: "p1", name: "Desk", host: "devbox.lan", username: "sam", auth: .password)
    let pi = SSHHostProfile(id: "p2", name: "pi", host: "10.0.0.9", username: "sam", auth: .password)
    func route(_ label: String, current: String? = nil, labels: Set<String> = []) -> ChatLinkRoute {
      ChatDeepLink(chatName: "c1", identityName: label)
        .route(profiles: [desk, pi], currentProfileID: current, currentHostLabels: labels)
    }
    XCTAssertEqual(route("homebox", current: "p2", labels: ["homebox"]), .openHere("c1"))
    XCTAssertEqual(route("devbox"), .open(profileID: "p1", chat: "c1"))
    XCTAssertEqual(route("pi", current: "p2"), .openHere("c1"))
    XCTAssertEqual(route("desk", current: "p2"), .open(profileID: "p1", chat: "c1"))
    XCTAssertEqual(route("elsewhere"), .none)
  }

  func test_the_chat_a_push_names_resumes_with_a_journal_and_is_read_only_without() {
    var journal = ChatJournal()
    let chats = [ACPChatSummary(name: "c1", isRunning: true, logBytes: 1, cwd: "/srv/app", created: .now, spawn: "x")]
    XCTAssertEqual(
      ChatRoute.opening(name: "c1", chats: chats, journal: journal), ChatRoute(name: "c1", cwd: "/srv/app", readOnly: true))
    journal.sessionId = "s"
    XCTAssertEqual(
      ChatRoute.opening(name: "c1", chats: chats, journal: journal), ChatRoute(name: "c1", cwd: "/srv/app", readOnly: false))
    XCTAssertEqual(
      ChatRoute.opening(name: "other", chats: chats, journal: journal), ChatRoute(name: "other", cwd: "", readOnly: false))
  }

  func test_the_confirmation_links_back_to_the_chat() {
    XCTAssertEqual(
      NotificationActionRunner.chatLink(for: ChatDeepLink(chatName: "c1", identityName: "dev box")),
      "tether://chat/c1?host=dev%20box")
  }

  func test_the_register_command_quotes_the_device_identity() {
    let identity = PushRegistrar.PushIdentity(token: "ab12", secretKey: "k+/=", label: "Sam's iPhone; x")
    XCTAssertEqual(
      PushRegistrar.registerCommand(notify: "tn", identity: identity),
      "tn register 'ab12' 'k+/=' 'Sam'\"'\"'s iPhone; x'")
  }
}
