import XCTest
@testable import TetherKit

final class ChatHostLogicTests: XCTestCase {
  func test_attach_command_spawns_only_for_a_new_chat() {
    XCTAssertEqual(
      ACPHostCommand.attach(name: "chat-ab12", cwd: "/home/sam/my app", spawn: true),
      "PATH=\"$HOME/.local/bin:$PATH\" tether-notify acp attach 'chat-ab12' --from 0 "
        + "--spawn 'npx -y @agentclientprotocol/claude-agent-acp@0.95.0' --cwd '/home/sam/my app'")
    XCTAssertEqual(
      ACPHostCommand.attach(name: "chat-ab12", cwd: "/x", spawn: false),
      "PATH=\"$HOME/.local/bin:$PATH\" tether-notify acp attach 'chat-ab12' --from 0")
  }

  func test_the_spawn_command_is_pinned_to_an_explicit_adapter_version() {
    XCTAssertEqual(ACPHostCommand.spawnCommand, "npx -y @agentclientprotocol/claude-agent-acp@0.95.0")
    let command = ACPHostCommand.attach(name: "c", cwd: "/x", spawn: true)
    XCTAssertTrue(command.contains("--spawn 'npx -y @agentclientprotocol/claude-agent-acp@0.95.0'"))
    XCTAssertEqual(shellQuote(ACPHostCommand.spawnCommand), "'npx -y @agentclientprotocol/claude-agent-acp@0.95.0'")
    XCTAssertFalse(ACPHostCommand.attach(name: "c", cwd: "/x", spawn: false).contains("npx"))
  }

  func test_shell_metacharacters_in_a_name_or_folder_are_quoted() {
    let command = ACPHostCommand.attach(name: "a'b", cwd: "/x; rm -rf /", spawn: true)
    XCTAssertTrue(command.contains("'a'\"'\"'b'"))
    XCTAssertTrue(command.contains("'/x; rm -rf /'"))
    XCTAssertEqual(ACPHostCommand.kill(name: "chat-1"), "PATH=\"$HOME/.local/bin:$PATH\" tether-notify acp kill 'chat-1'")
  }

  func test_listing_parses_tab_separated_lines_newest_first() {
    let output = """
      chat-old\tended\t120\t/srv/api\t1700000000\tnpx -y agent
      chat-new\trunning\t9000\t/home/sam/site\t1700005000\tnpx -y agent --flag
      """
    let listing = ACPChatListing.parse(output)
    XCTAssertEqual(listing.chats.map(\.name), ["chat-new", "chat-old"])
    XCTAssertEqual(listing.chats[0].isRunning, true)
    XCTAssertEqual(listing.chats[0].logBytes, 9000)
    XCTAssertEqual(listing.chats[0].title, "site")
    XCTAssertEqual(listing.chats[0].spawn, "npx -y agent --flag")
    XCTAssertEqual(listing.chats[0].created, Date(timeIntervalSince1970: 1_700_005_000))
    XCTAssertEqual(listing.chats[1].isRunning, false)
    XCTAssertTrue(listing.skipped.isEmpty)
  }

  func test_listing_keeps_a_chat_with_no_spawn_field_and_skips_garbage() {
    let listing = ACPChatListing.parse("c\trunning\t1\t/x\t5\nzsh: command not found: tether-notify\nc2\tpaused\t1\t/x\t5\n")
    XCTAssertEqual(listing.chats.map(\.name), ["c"])
    XCTAssertEqual(listing.chats[0].spawn, "")
    XCTAssertEqual(listing.skipped.count, 2)
    XCTAssertEqual(ACPChatListing.parse("").chats, [])
  }

  func test_titles_fall_back_for_home_and_root() {
    XCTAssertEqual(ChatFormat.folderName("/home/sam/site/"), "site")
    XCTAssertEqual(ChatFormat.folderName("/"), "/")
    XCTAssertEqual(ChatFormat.folderName(""), "Home")
  }

  func test_cwd_expands_tilde_against_the_host_home() {
    XCTAssertEqual(ACPCwd.expand("~", home: "/home/sam"), "/home/sam")
    XCTAssertEqual(ACPCwd.expand("  ", home: "/home/sam"), "/home/sam")
    XCTAssertEqual(ACPCwd.expand("~/code/app/", home: "/home/sam"), "/home/sam/code/app")
    XCTAssertEqual(ACPCwd.expand("/srv/api", home: "/home/sam"), "/srv/api")
    XCTAssertEqual(ACPCwd.expand("/", home: "/home/sam"), "/")
    XCTAssertTrue(ACPCwd.needsHome("~/x"))
    XCTAssertFalse(ACPCwd.needsHome("/srv"))
  }

  func test_a_chat_without_a_local_session_opens_read_only() {
    XCTAssertEqual(ChatOpenMode.mode(for: ChatJournal()), .readOnly)
    var journal = ChatJournal()
    journal.sessionId = "s"
    XCTAssertEqual(ChatOpenMode.mode(for: journal), .resume)
  }

  func test_the_link_is_interactive_only_after_the_replay_goes_quiet() {
    var link = ChatLinkTracker()
    let start = Date(timeIntervalSince1970: 1000)
    XCTAssertFalse(link.allowsInteraction)
    link.dialSucceeded(at: start)
    XCTAssertEqual(link.phase, .catchingUp)
    XCTAssertFalse(link.settleIfQuiet(at: start.addingTimeInterval(0.39)))
    link.activity(at: start.addingTimeInterval(0.39))
    XCTAssertFalse(link.settleIfQuiet(at: start.addingTimeInterval(0.7)))
    XCTAssertTrue(link.settleIfQuiet(at: start.addingTimeInterval(0.8)))
    XCTAssertTrue(link.allowsInteraction)
    link.activity(at: start.addingTimeInterval(5))
    XCTAssertEqual(link.phase, .live)
    link.connectionLost()
    XCTAssertFalse(link.allowsInteraction)
    XCTAssertFalse(link.settleIfQuiet(at: start.addingTimeInterval(9)))
  }

  func test_reconnect_only_when_lost_and_not_already_dialing() {
    XCTAssertTrue(ChatReconnectPolicy.shouldReconnect(phase: .lost, dialInFlight: false, left: false))
    XCTAssertFalse(ChatReconnectPolicy.shouldReconnect(phase: .lost, dialInFlight: true, left: false))
    XCTAssertFalse(ChatReconnectPolicy.shouldReconnect(phase: .lost, dialInFlight: false, left: true))
    for phase in [ChatLinkTracker.Phase.connecting, .catchingUp, .live] {
      XCTAssertFalse(ChatReconnectPolicy.shouldReconnect(phase: phase, dialInFlight: false, left: false))
    }
  }

  func test_outbox_keeps_failed_messages_until_discarded() {
    var outbox = ChatOutbox()
    let first = outbox.recordFailure("one")
    let second = outbox.recordFailure("two")
    XCTAssertEqual(outbox.failed.map(\.text), ["one", "two"])
    XCTAssertEqual(outbox.text(for: second.id), "two")
    outbox.discard(first.id)
    XCTAssertEqual(outbox.failed.map(\.text), ["two"])
    XCTAssertNil(outbox.text(for: first.id))
  }

  func test_permission_options_order_allow_then_always_then_reject() {
    let options = [
      ACPPermissionOption(optionId: "r", name: "No", kind: "reject_once"),
      ACPPermissionOption(optionId: "a", name: "Always", kind: "allow_always"),
      ACPPermissionOption(optionId: "o", name: "Yes", kind: "allow_once"),
      ACPPermissionOption(optionId: "x", name: "Never", kind: "reject_always"),
    ]
    let ordered = ChatPermissionOptions.ordered(options)
    XCTAssertEqual(ordered.map(\.option.optionId), ["o", "a", "r", "x"])
    XCTAssertEqual(ordered.map(\.role), [.primary, .secondary, .destructive, .destructive])
  }

  func test_context_summary_and_counts() {
    XCTAssertEqual(ChatFormat.compactCount(950), "950")
    XCTAssertEqual(ChatFormat.compactCount(31_043), "31k")
    XCTAssertEqual(ChatFormat.compactCount(1_000_000), "1M")
    XCTAssertEqual(ChatFormat.compactCount(1_500_000), "1.5M")
    XCTAssertEqual(ChatFormat.contextSummary(used: 31_043, size: 1_000_000), "31k / 1M · 3%")
    XCTAssertNil(ChatFormat.contextSummary(used: nil, size: 10))
    XCTAssertNil(ChatFormat.contextSummary(used: 1, size: 0))
  }

  func test_relative_paths_only_drop_the_folder_prefix() {
    XCTAssertEqual(ChatFormat.relativePath("/work/p/src/a.ts", to: "/work/p"), "src/a.ts")
    XCTAssertEqual(ChatFormat.relativePath("/work/other/a.ts", to: "/work/p"), "/work/other/a.ts")
    XCTAssertEqual(ChatFormat.relativePath("/work/pp/a.ts", to: "/work/p"), "/work/pp/a.ts")
  }

  func test_every_tool_kind_has_a_symbol() {
    for kind in [ACPToolKind.read, .edit, .delete, .move, .search, .execute, .think, .fetch, .switchMode, .other] {
      XCTAssertFalse(kind.symbolName.isEmpty)
    }
  }

  func test_the_tail_signature_moves_with_streamed_text_and_not_without_it() {
    var state = ChatState()
    state = ChatReducer.reduce(state, .message(.update(.agentMessage(text: "he", messageId: "m"))))
    let before = state.tailSignature
    XCTAssertEqual(before, state.tailSignature)
    state = ChatReducer.reduce(state, .message(.update(.agentMessage(text: "llo", messageId: "m"))))
    XCTAssertNotEqual(before, state.tailSignature)
  }

  func test_an_undelivered_prompt_leaves_the_transcript_and_ends_the_turn() {
    var state = ChatReducer.reduce(ChatState(), .userPrompt(text: "hi", atOffset: 0))
    state = ChatReducer.reduce(state, .userPrompt(text: "again", atOffset: 0))
    state = ChatReducer.reduce(state, .promptUndelivered(text: "hi", atOffset: 0))
    XCTAssertEqual(state.items.map(\.kind), [.user(text: "again", offset: 0)])
    XCTAssertEqual(state.turn, .working, "the other prompt is still in flight")
    state = ChatReducer.reduce(state, .promptUndelivered(text: "again", atOffset: 0))
    XCTAssertEqual(state.turn, .idle)
  }

  func test_parent_path_and_agent_label_for_a_chat_row() {
    XCTAssertEqual(ChatFormat.parentPath("/home/dev/projects/api"), "/home/dev/projects")
    XCTAssertEqual(ChatFormat.parentPath("/srv"), "/")
    XCTAssertEqual(ChatFormat.parentPath("~/work/api"), "~/work")
    XCTAssertNil(ChatFormat.parentPath("~"))
    XCTAssertNil(ChatFormat.parentPath("/"))
    XCTAssertEqual(ChatFormat.agentLabel(spawn: "npx -y @agentclientprotocol/claude-agent-acp"), "Claude")
    XCTAssertEqual(ChatFormat.agentLabel(spawn: "codex-acp"), "Codex")
    XCTAssertNil(ChatFormat.agentLabel(spawn: "npx -y something"))
  }

  func test_context_fraction_is_clamped_and_needs_a_size() {
    XCTAssertEqual(ChatFormat.contextFraction(used: 250, size: 1000), 0.25)
    XCTAssertEqual(ChatFormat.contextFraction(used: 2000, size: 1000), 1)
    XCTAssertNil(ChatFormat.contextFraction(used: 5, size: 0))
    XCTAssertNil(ChatFormat.contextFraction(used: nil, size: 10))
  }

  func test_permission_slots_split_allow_deny_and_broader_allows() {
    let options = [
      ACPPermissionOption(optionId: "always", name: "Yes, allow all edits", kind: "allow_always"),
      ACPPermissionOption(optionId: "no", name: "No", kind: "reject_once"),
      ACPPermissionOption(optionId: "once", name: "Yes", kind: "allow_once"),
    ]
    let slots = ChatPermissionOptions.slots(options)
    XCTAssertEqual(slots.allow?.optionId, "once")
    XCTAssertEqual(slots.deny?.optionId, "no")
    XCTAssertEqual(slots.extras.map(\.optionId), ["always"])
  }
}
