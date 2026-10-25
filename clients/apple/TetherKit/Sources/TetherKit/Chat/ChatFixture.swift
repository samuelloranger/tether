#if DEBUG
import Foundation
import SwiftUI

/// A recorded-shape agent turn replayed over a fake stream, so the chat screen can be driven
/// without a host: `TETHER_DEBUG_CHAT_FIXTURE=1` shows the finished turn, `=permission` stops at
/// the question.
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

/// DEBUG root for screenshots: the chat screen alone, over the fixture.
public struct ChatFixtureRoot: View {
  @State private var model: ChatSessionModel

  public init(pendingPermission: Bool) {
    _model = State(initialValue: ChatFixture.model(pendingPermission: pendingPermission))
  }

  public var body: some View {
    NavigationStack { ChatView(model: model) }
      .tint(TetherColors.accent)
      .preferredColorScheme(ChromeTheme.shared.isLight ? .light : .dark)
  }
}
#endif
