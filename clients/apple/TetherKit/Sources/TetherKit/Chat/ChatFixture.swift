#if DEBUG
import Foundation
import SwiftUI

/// A recorded-shape agent turn replayed over a fake stream, so the chat screen can be driven
/// without a host: `TETHER_DEBUG_CHAT_FIXTURE=1` shows the finished turn, `=permission` stops at
/// the question, `=stream` drips a long reply over several seconds, `=list` shows the chat list, `=controls`, `=controls-sheet`, `=slash` and `=attach` show the options, commands and image paths.
enum ChatFixture {
  static let promptText = "Add a retry with backoff to fetchJSON and cover it with a test."
  static let permissionRequestId = 7

  private static func json(_ object: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    return String(decoding: data, as: UTF8.self)
  }

  private static func update(_ body: [String: Any]) -> String {
    json([
      "jsonrpc": "2.0", "method": "session/update",
      "params": ["sessionId": "sess-1", "update": body],
    ])
  }

  private static func message(_ text: String) -> String {
    update([
      "sessionUpdate": "agent_message_chunk", "messageId": "msg_1",
      "content": ["type": "text", "text": text],
    ])
  }

  private static func tool(
    _ id: String, _ title: String, kind: String, status: String, text: String? = nil, diff: [String: Any]? = nil,
    update isUpdate: Bool = false
  ) -> [String: Any] {
    var content: [[String: Any]] = []
    if let text { content.append(["type": "content", "content": ["type": "text", "text": text]]) }
    if let diff { content.append(diff) }
    return [
      "sessionUpdate": isUpdate ? "tool_call_update" : "tool_call", "toolCallId": id, "title": title,
      "kind": kind, "status": status, "content": content,
    ]
  }

  private static let editDiff: [String: Any] = [
    "type": "diff", "path": "/work/project/src/fetch.ts",
    "oldText": """
    export async function fetchJSON(url: string) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    export const DEFAULT_TIMEOUT = 5000
    export const USER_AGENT = "tether-demo"
    export const MAX_BODY = 1_000_000
    """,
    "newText": """
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    export async function fetchJSON(url: string, attempts = 3) {
      for (let attempt = 1; ; attempt++) {
        const response = await fetch(url)
        if (response.ok) return response.json()
        if (attempt >= attempts || response.status < 500) throw new Error(`HTTP ${response.status}`)
        await sleep(2 ** attempt * 100)
      }
    }

    export const DEFAULT_TIMEOUT = 5000
    export const USER_AGENT = "tether-demo"
    export const MAX_BODY = 1_000_000
    """,
  ]

  private static let permission = json([
    "jsonrpc": "2.0", "id": permissionRequestId, "method": "session/request_permission",
    "params": [
      "sessionId": "sess-1",
      "toolCall": tool("tool_edit", "Edit src/fetch.ts", kind: "edit", status: "pending", diff: editDiff),
      "options": [
        ["optionId": "allow-once", "name": "Yes", "kind": "allow_once"],
        ["optionId": "allow-always", "name": "Yes, allow all edits this session", "kind": "allow_always"],
        ["optionId": "reject", "name": "No", "kind": "reject_once"],
      ],
    ],
  ])

  private static let beforePermission: [String] = [
    update(["sessionUpdate": "session_info_update", "title": "Retry for fetchJSON"]),
    update(["sessionUpdate": "agent_thought_chunk", "content": ["type": "text", "text": "The helper has no retry. I should keep 4xx errors fatal and back off only on 5xx."]]),
    update([
      "sessionUpdate": "plan",
      "entries": [
        ["content": "Read the fetch helper", "status": "completed", "priority": "high"],
        ["content": "Add retry with backoff", "status": "in_progress", "priority": "high"],
        ["content": "Write a test and run the suite", "status": "pending", "priority": "medium"],
      ],
    ]),
    update(tool("tool_read", "Read src/fetch.ts", kind: "read", status: "pending")),
    update(tool("tool_read", "Read src/fetch.ts", kind: "read", status: "completed",
      text: "export async function fetchJSON(url: string) {\n  const response = await fetch(url)\n  …", update: true)),
    update(tool("tool_grep", "Search fetchJSON in src", kind: "search", status: "completed", text: "src/api.ts:12\nsrc/fetch.ts:1", update: false)),
    message("I'll add **bounded retries** to `fetchJSON`:\n\n- retry only on `5xx` responses\n- exponential backoff starting at 200 ms\n- give up after three attempts\n\nHere is the change I'm about to make:\n\n```ts\nfor (let attempt = 1; ; attempt++) { … }\n```"),
    update([
      "sessionUpdate": "usage_update", "used": 41_250, "size": 1_000_000,
    ]),
    update(tool("tool_edit", "Edit src/fetch.ts", kind: "edit", status: "pending", diff: editDiff)),
    permission,
  ]

  private static let afterPermission: [String] = [
    update(tool("tool_edit", "Edit src/fetch.ts", kind: "edit", status: "completed", update: true)),
    update(tool("tool_test", "bun test src/fetch.test.ts", kind: "execute", status: "completed",
      text: "✓ retries a 503 then succeeds\n✓ does not retry a 404\n\n 2 pass, 0 fail", update: false)),
    update(["sessionUpdate": "usage_update", "used": 48_900, "size": 1_000_000]),
    message("\n\nDone. `fetchJSON` now retries **5xx** responses up to three times with backoff, and the two new tests pass. A `404` still fails immediately."),
    json(["jsonrpc": "2.0", "id": 3, "result": ["stopReason": "end_turn"]]),
  ]

  /// Agent lines in log order; the permission request is the last of the first group.
  static func lines(pendingPermission: Bool) -> [String] {
    pendingPermission ? beforePermission : beforePermission + afterPermission
  }

  static func log(pendingPermission: Bool) -> Data {
    Data((lines(pendingPermission: pendingPermission).joined(separator: "\n") + "\n").utf8)
  }

  /// A long reply that overflows the screen, delivered a chunk at a time.
  static let dripChunks: [String] = {
    var chunks = [update([
      "sessionUpdate": "agent_message_chunk", "messageId": "msg_stream",
      "content": ["type": "text", "text": "Here is the full walkthrough, one step at a time.\n\n"],
    ])]
    for step in 1...36 {
      chunks.append(update([
        "sessionUpdate": "agent_message_chunk", "messageId": "msg_stream",
        "content": ["type": "text", "text": "Step \(step): the helper keeps its state small, retries only on server errors and waits a little longer each time.\n\n"],
      ]))
    }
    chunks.append(update([
      "sessionUpdate": "agent_message_chunk", "messageId": "msg_stream",
      "content": ["type": "text", "text": "END OF REPLY"],
    ]))
    chunks.append(json(["jsonrpc": "2.0", "id": 3, "result": ["stopReason": "end_turn"]]))
    return chunks
  }()

  /// A long finished turn, rendered whole: grouped tool rows and plenty of prose.
  @MainActor
  static func longModel() -> ChatSessionModel {
    var lines: [String] = [
      update(["sessionUpdate": "session_info_update", "title": "Chat feature"]),
      update(tool("t1", "Edit apps/tether-notify/README.md", kind: "edit", status: "completed")),
      update(tool("t2", "ls -la /work/project/.codegraph", kind: "execute", status: "completed", text: "total 8")),
      update(tool("t3", "Read src/fetch.ts", kind: "read", status: "completed", text: "export async function fetchJSON")),
      update(["sessionUpdate": "usage_update", "used": 41_250, "size": 1_000_000]),
      message("Edited `apps/tether-notify/README.md` line 3: \"the v5 SSH host\" is now \"the SSH host\". It's uncommitted. Revert with `git checkout apps/tether-notify/README.md`.\n\nThe `ship:scout` subagent is exploring the repo in the background. I'll relay its report when it finishes."),
      message("\n\n## Entry points\n\n- iOS and Mac Catalyst: `clients/apple/TetherIOS` is the app target, with `TetherKit` holding the SSH transport and every screen\n- Windows and Linux: `clients/desktop/` is one Rust workspace with a Slint UI\n- Host side: `apps/tether-notify/` is a small Go tool for encrypted push\n\n"),
    ]
    for step in 1...6 {
      lines.append(message("Step \(step): the helper keeps its state small, retries only on `5xx` server errors and waits a little longer each time, so a flaky upstream does not hammer the host.\n\n"))
    }
    lines.append(message("```ts\nfor (let attempt = 1; ; attempt++) { await sleep(2 ** attempt * 100) }\n```\n\nDone."))
    lines.append(json(["jsonrpc": "2.0", "id": 3, "result": ["stopReason": "end_turn"]]))
    let log = Data((lines.joined(separator: "\n") + "\n").utf8)
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 4
    journal.entries = [.init(kind: .prompt, offset: 0, text: "What does this repo do?")]
    return ChatSessionModel(
      chatName: "fixture", cwd: "/work/tether", readOnly: false,
      store: InMemoryChatJournalStore(journal)
    ) { _ in FixtureByteStream(log: log) }
  }

  private static func option(
    _ id: String, _ name: String, _ description: String, current: String, _ choices: [(String, String, String)]
  ) -> [String: Any] {
    [
      "id": id, "name": name, "description": description, "category": id, "type": "select",
      "currentValue": current,
      "options": choices.map { ["value": $0.0, "name": $0.1, "description": $0.2] },
    ]
  }

  private static let controlOptions: [[String: Any]] = [
    option("mode", "Mode", "Session permission mode", current: "plan", [
      ("default", "Manual", "Always ask before making changes"),
      ("acceptEdits", "Accept edits", "Automatically accept all file edits"),
      ("plan", "Plan", "Create a plan before making changes"),
      ("auto", "Auto", "The agent handles permission decisions"),
      ("bypassPermissions", "Bypass permissions", "Accepts all permissions"),
    ]),
    option("model", "Model", "The model for this session", current: "sonnet", [
      ("opus", "Opus 5", "Most capable, slower"),
      ("sonnet", "Sonnet 5.5", "Everyday coding"),
      ("haiku", "Haiku 5.5", "Fastest, lightest"),
    ]),
    option("effort", "Effort", "How hard the agent thinks", current: "medium", [
      ("low", "Low", "Quick answers"),
      ("medium", "Medium", "Balanced"),
      ("high", "High", "Thorough reasoning"),
    ]),
    option("agent", "Agent", "Which agent profile runs", current: "main", [
      ("main", "Main", "The default agent"),
      ("reviewer", "Reviewer", "Read-only code review"),
    ]),
  ]

  private static let controlCommands: [[String: Any]] = [
    ("compact", "Summarise the conversation to free context", "<instructions>"),
    ("context", "Show what is using the context window", nil),
    ("review", "Review the pending changes", nil),
    ("effort", "Set how hard the agent thinks", "<level>"),
    ("model", "Switch the model for this session", "<name>"),
    ("plan", "Draft a plan before editing anything", nil),
    ("init", "Create a project guide file", nil),
    ("cost", "Show what this session has cost", nil),
    ("clear", "Start over with an empty conversation", nil),
    ("config", "Open the agent settings", nil),
    ("doctor", "Check the agent installation", nil),
    ("memory", "Edit the saved project notes", nil),
    ("status", "Show version, model and account", nil),
    ("resume", "Pick an earlier conversation", "<id>"),
    ("security-review", "Look for security problems in the diff", nil),
  ].map { name, description, hint in
    var command: [String: Any] = ["name": name, "description": description]
    command["input"] = hint.map { ["hint": $0] } ?? NSNull()
    return command
  }

  /// A finished turn with the agent's options, commands, usage with a cost, and an image prompt.
  @MainActor
  static func controlsModel() -> ChatSessionModel {
    let head: [String] = [
      update(["sessionUpdate": "session_info_update", "title": "Retry for fetchJSON"]),
      update(["sessionUpdate": "config_option_update", "configOptions": controlOptions]),
      update(["sessionUpdate": "available_commands_update", "availableCommands": controlCommands]),
      update(tool("t1", "Read src/fetch.ts", kind: "read", status: "completed", text: "export async function fetchJSON")),
      message("`fetchJSON` has no retry. I'll keep `4xx` errors fatal and back off only on `5xx`."),
      json(["jsonrpc": "2.0", "id": 3, "result": ["stopReason": "end_turn"]]),
    ]
    let tail: [String] = [
      update(tool("t2", "Edit src/fetch.ts", kind: "edit", status: "completed")),
      message("Done. The helper now retries up to three times."),
      update([
        "sessionUpdate": "usage_update", "used": 20_000, "size": 1_000_000,
        "cost": ["amount": 0.157, "currency": "USD"], "_meta": ["_claude/model": "claude-sonnet-5-5"],
      ]),
      json(["jsonrpc": "2.0", "id": 4, "result": ["stopReason": "end_turn"]]),
    ]
    let log = Data(((head + tail).joined(separator: "\n") + "\n").utf8)
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 5
    journal.entries = [
      .init(kind: .prompt, offset: 0, text: promptText),
      .init(
        kind: .prompt, offset: head.reduce(0) { $0 + $1.utf8.count + 1 },
        text: "Here are the two failing screens.", imageCount: 2),
    ]
    return ChatSessionModel(
      chatName: "fixture", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(journal)
    ) { _ in FixtureByteStream(log: log) }
  }

  @MainActor
  static func streamModel() -> ChatSessionModel {
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 4
    journal.entries = [.init(kind: .prompt, offset: 0, text: promptText)]
    return ChatSessionModel(
      chatName: "fixture", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(journal)
    ) { _ in DripByteStream(chunks: dripChunks) }
  }

  static func journal(pendingPermission: Bool) -> ChatJournal {
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 4
    journal.entries = [.init(kind: .prompt, offset: 0, text: promptText)]
    if !pendingPermission {
      let answerOffset = beforePermission.reduce(0) { $0 + $1.utf8.count + 1 }
      journal.entries.append(
        .init(kind: .answer, offset: answerOffset, requestId: .int(permissionRequestId), optionId: "allow-once"))
    }
    return journal
  }

  @MainActor
  static func model(pendingPermission: Bool) -> ChatSessionModel {
    let log = log(pendingPermission: pendingPermission)
    return ChatSessionModel(
      chatName: "fixture", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(journal(pendingPermission: pendingPermission))
    ) { _ in FixtureByteStream(log: log) }
  }
}

/// Hands over its log once, then stays open and silent like a quiet host.
final class FixtureByteStream: TerminalByteStream, @unchecked Sendable {
  private let lock = NSLock()
  private var log: Data?
  private var waiter: CheckedContinuation<Data?, Never>?
  private var closed = false

  init(log: Data) { self.log = log }

  func read() async throws -> Data? {
    await withCheckedContinuation { continuation in
      lock.lock()
      if let log {
        self.log = nil
        lock.unlock()
        continuation.resume(returning: log)
      } else if closed {
        lock.unlock()
        continuation.resume(returning: nil)
      } else {
        waiter = continuation
        lock.unlock()
      }
    }
  }

  func write(_ bytes: Data) async throws {}

  func close() async {
    lock.lock()
    closed = true
    let pending = waiter
    waiter = nil
    lock.unlock()
    pending?.resume(returning: nil)
  }
}

/// Hands over one line per tick, like a streaming agent, then stays open and silent.
final class DripByteStream: TerminalByteStream, @unchecked Sendable {
  private let lock = NSLock()
  private var chunks: [String]
  private var closed = false
  private let interval: UInt64

  init(chunks: [String], intervalMs: UInt64 = 250) {
    self.chunks = chunks
    interval = intervalMs * 1_000_000
  }

  func read() async throws -> Data? {
    while true {
      try await Task.sleep(nanoseconds: interval)
      lock.lock()
      if closed { lock.unlock(); return nil }
      if !chunks.isEmpty {
        let next = chunks.removeFirst()
        lock.unlock()
        return Data((next + "\n").utf8)
      }
      lock.unlock()
    }
  }

  func write(_ bytes: Data) async throws {}

  func close() async {
    lock.lock()
    closed = true
    lock.unlock()
  }
}

/// DEBUG root for screenshots: the chat screen alone, over the fixture.
public struct ChatFixtureRoot: View {
  @State private var model: ChatSessionModel

  private let listMode: Bool
  @State private var listModel = ChatListModel(hostName: "homelab", exec: { _ in
    let now = Int(Date().timeIntervalSince1970)
    return [
      "chat-a\trunning\t48213\t/home/dev/projects/api-server\t\(now - 600)\tclaude",
      "chat-b\tended\t9120\t/home/dev/projects/mobile-app\t\(now - 86400)\tclaude",
      "chat-c\tended\t1840\t~\t\(now - 259200)\tcodex",
    ].joined(separator: "\n")
  })

  private let mode: String

  public init(mode: String) {
    self.mode = mode
    listMode = mode == "list"
    let initial: ChatSessionModel
    switch mode {
    case "stream": initial = ChatFixture.streamModel()
    case "keyboard", "scrolledup": initial = ChatFixture.longModel()
    case "controls", "controls-sheet", "slash", "attach": initial = ChatFixture.controlsModel()
    default: initial = ChatFixture.model(pendingPermission: mode == "permission")
    }
    _model = State(initialValue: initial)
  }

  public var body: some View {
    NavigationStack {
      if listMode {
        ChatListView(model: listModel, onOpen: { _ in }, onClose: {})
          .task { await listModel.refresh() }
      } else {
        ChatView(
          model: model, focusComposer: mode == "keyboard" || mode == "slash", startAtTop: mode == "scrolledup",
          initialDraft: mode == "slash" ? "/co" : mode == "attach" ? "Compare these two screenshots" : "",
          openControls: mode == "controls-sheet", seedAttachments: mode == "attach")
      }
    }
      .tint(TetherColors.accent)
      .preferredColorScheme(ChromeTheme.shared.isLight ? .light : .dark)
  }
}
#endif
