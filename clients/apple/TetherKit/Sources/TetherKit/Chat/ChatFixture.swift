#if DEBUG
import Foundation
import SwiftUI

/// A recorded-shape agent turn replayed over a fake stream, so the chat screen can be driven
/// without a host: `TETHER_DEBUG_CHAT_FIXTURE=1` shows the finished turn, `=permission` stops at
/// the question, `=stream` drips a long reply over several seconds, `=send` types a draft and sends it into a long transcript (agent silent for `TETHER_DEBUG_REPLY_AFTER` seconds, default 8, then a long reply), `=subagents` and `=subagents-open` show a foreground and a background subagent, `=list` shows the chat list, `=question`, `=question-multi`, `=question-other` and `=question-answered` show an agent question (single choice, two questions with a multi-select and Other, Other open with the keyboard, and the resolved row), `=plan` shows a plan approval with five options, `=plan-more` with the disclosure open, `=plan-sheet` with the full plan sheet, `=queue`, `=clear` and `=signedout` show a queued message, a cleared context and the sign-in row, `=controls`, `=controls-sheet`, `=slash` and `=attach` show the options, commands and image paths, `=mention` and `=mention-all` the `@file` palette for a typed word and a bare `@`.
enum ChatFixture {
  static let promptText = "Add a retry with backoff to fetchJSON and cover it with a test."
  static let permissionRequestId = 7
  static let sendDraft = "Thanks. Now do the same for the other helpers,\nthen run the whole suite\nand summarise anything that fails."


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
    update isUpdate: Bool = false, parent: String? = nil, toolName: String? = nil, input: [String: Any]? = nil
  ) -> [String: Any] {
    var content: [[String: Any]] = []
    if let text { content.append(["type": "content", "content": ["type": "text", "text": text]]) }
    if let diff { content.append(diff) }
    var frame: [String: Any] = [
      "sessionUpdate": isUpdate ? "tool_call_update" : "tool_call", "toolCallId": id, "title": title,
      "kind": kind, "status": status, "content": content,
    ]
    var claude: [String: Any] = [:]
    if let parent { claude["parentToolUseId"] = parent }
    if let toolName { claude["toolName"] = toolName }
    if !claude.isEmpty { frame["_meta"] = ["claudeCode": claude] }
    if let input { frame["rawInput"] = input }
    return frame
  }

  static let questionRequestId = 8
  /// Set by the debug root so the question card opens its Other field with text typed in.
  nonisolated(unsafe) static var openQuestionOther = false

  private static func choice(_ value: String, _ description: String) -> [String: Any] {
    ["const": value, "title": value, "description": description]
  }

  /// The recorded single-select question, as the adapter sent it.
  private static let colourProperties: [String: Any] = [
    "question_0": [
      "type": "string", "title": "Colour",
      "oneOf": [choice("red", "Red"), choice("green", "Green"), choice("blue", "Blue")],
    ],
    "question_0_custom": [
      "type": "string", "title": "Other",
      "description": "Type your own answer, or add a note to the option you chose above (optional).",
    ],
  ]

  private static let runnerProperties: [String: Any] = [
    "question_0": [
      "type": "string", "title": "Test runner",
      "oneOf": [
        choice("vitest", "Fast, Vite-native, watch mode"),
        choice("jest", "The long-standing default"),
        choice("bun", "Built in, no extra dependency"),
      ],
    ],
    "question_1": [
      "type": "array", "title": "Checks to run in CI",
      "items": [
        "anyOf": [
          choice("lint", "Biome lint and format check"),
          choice("types", "tsc --noEmit"),
          choice("unit", "The whole unit suite"),
          choice("e2e", "Simulator UI tests, slower"),
        ],
      ],
    ],
    "question_1_custom": [
      "type": "string", "title": "Other",
      "description": "Type your own answer, or add a note to the option you chose above (optional).",
    ],
  ]

  private static func elicitation(message: String, properties: [String: Any]) -> String {
    json([
      "jsonrpc": "2.0", "id": questionRequestId, "method": "elicitation/create",
      "params": [
        "mode": "form", "sessionId": "sess-1", "toolCallId": "toolu_question", "message": message,
        "requestedSchema": ["type": "object", "properties": properties],
      ],
    ])
  }

  private static func askTool() -> [String] {
    [
      update(tool("toolu_question", "Asking for your input", kind: "other", status: "pending", toolName: "AskUserQuestion", input: [:])),
    ]
  }

  /// An agent question left open (`answered: false`) or answered with red.
  @MainActor
  static func questionModel(multi: Bool = false, answered: Bool = false) -> ChatSessionModel {
    var lines: [String] = [
      update(["sessionUpdate": "session_info_update", "title": multi ? "CI setup" : "Colour preference"]),
      message(multi
        ? "I can set up CI for the app, but two choices change what I build."
        : "Before I pick a theme I need one preference."),
    ]
    lines += askTool()
    let request = multi
      ? elicitation(message: "Two quick questions before I set up CI", properties: runnerProperties)
      : elicitation(message: "Which colour do you prefer?", properties: colourProperties)
    lines.append(request)
    let offset = lines.reduce(0) { $0 + $1.utf8.count + 1 }
    if answered {
      lines.append(message("Red it is. I'll use it for the accent colour."))
      lines.append(json(["jsonrpc": "2.0", "id": 3, "result": ["stopReason": "end_turn"]]))
    }
    let log = Data((lines.joined(separator: "\n") + "\n").utf8)
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 4
    journal.entries = [.init(kind: .prompt, offset: 0, text: multi ? "Set up CI for this app." : "Pick a theme for the app.")]
    if answered {
      journal.entries.append(
        .init(kind: .questionAnswer, offset: offset, requestId: .int(questionRequestId), optionId: "accept",
          content: ["question_0": .text("red")]))
    }
    return ChatSessionModel(
      chatName: "fixture", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(journal)
    ) { _, _ in FixtureByteStream(log: log) }
  }

  /// Set by the debug root: `plan-more` opens the disclosure, `plan-sheet` the full plan.
  nonisolated(unsafe) static var planMode = ""

  static let planMarkdown = """
  ## Plan: retry with backoff in fetchJSON

  **Context.** `fetchJSON` fails on the first 5xx, which makes the nightly sync flaky.

  1. Add an `attempts` parameter, default 3
  2. Retry only on `5xx`; keep `4xx` fatal
  3. Back off `2^attempt * 100` ms between tries
  4. Cover it in `src/fetch.test.ts`: a 503 then success, and a 404 that does not retry

  ### Files

  - `src/fetch.ts`
  - `src/fetch.test.ts`

  ### Verification

  Run `bun test src/fetch.test.ts`, then the whole suite.
  """

  /// The plan-mode approval as the adapter sends it: one `switch_mode` request with five options.
  @MainActor
  static func planModel() -> ChatSessionModel {
    let request = json([
      "jsonrpc": "2.0", "id": permissionRequestId, "method": "session/request_permission",
      "params": [
        "sessionId": "sess-1",
        "toolCall": [
          "toolCallId": "toolu_plan", "title": "Approve Plan", "kind": "switch_mode", "status": "pending",
          "content": [["type": "content", "content": ["type": "text", "text": planMarkdown]]],
        ],
        "options": [
          ["optionId": "default", "name": "Yes, manually approve edits", "kind": "allow_once"],
          ["optionId": "acceptEdits", "name": "Yes, clear context (31% used) and use auto mode", "kind": "allow_always"],
          ["optionId": "auto", "name": "Yes, and use auto mode", "kind": "allow_always"],
          ["optionId": "bypassPermissions", "name": "Yes, and bypass permissions", "kind": "allow_always"],
          ["optionId": "plan", "name": "No, keep planning", "kind": "reject_once"],
        ],
      ],
    ])
    let lines = [
      update(["sessionUpdate": "session_info_update", "title": "Retry for fetchJSON"]),
      message("I've read the helper and its callers. The plan is ready for your approval."),
      update(["sessionUpdate": "usage_update", "used": 41_250, "size": 1_000_000]),
      request,
    ]
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 4
    journal.entries = [.init(kind: .prompt, offset: 0, text: promptText)]
    let log = Data((lines.joined(separator: "\n") + "\n").utf8)
    return ChatSessionModel(
      chatName: "fixture", cwd: "/work/project", readOnly: false, store: InMemoryChatJournalStore(journal)
    ) { _, _ in FixtureByteStream(log: log) }
  }

  /// A turn still running with a message typed ahead (`queued`), a finished `/clear`, or a signed-out agent.
  @MainActor
  static func contextModel(_ kind: String) -> ChatSessionModel {
    var lines = [update(["sessionUpdate": "session_info_update", "title": "Retry for fetchJSON"])]
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 6
    switch kind {
    case "queue":
      lines += [
        message("Working through the helpers. `fetchJSON` is done; moving on to `fetchText`."),
        update(tool("t1", "Edit src/text.ts", kind: "edit", status: "in_progress")),
      ]
      journal.entries = [
        .init(kind: .prompt, offset: 0, text: promptText, requestId: .int(3)),
        .init(kind: .prompt, offset: 0, text: "After that, update the README too.", requestId: .int(4)),
      ]
    case "clear":
      lines += [
        message("Done. `fetchJSON` retries 5xx responses up to three times."),
        json(["jsonrpc": "2.0", "id": 3, "result": ["stopReason": "end_turn"]]),
        json(["jsonrpc": "2.0", "id": 4, "result": ["stopReason": "end_turn"]]),
      ]
      let first = lines.prefix(2).reduce(0) { $0 + $1.utf8.count + 1 }
      journal.entries = [
        .init(kind: .prompt, offset: 0, text: promptText, requestId: .int(3)),
        .init(kind: .prompt, offset: first + lines[2].utf8.count + 1, text: "/clear", requestId: .int(4)),
      ]
    default:
      lines += [
        json([
          "jsonrpc": "2.0", "method": "_auth/status_update",
          "params": ["authStatus": ["kind": "none", "label": "Not logged in"]],
        ]),
        json(["jsonrpc": "2.0", "id": 3, "error": ["code": -32000, "message": "Authentication required"]]),
      ]
      journal.entries = [.init(kind: .prompt, offset: 0, text: promptText, requestId: .int(3))]
    }
    let log = Data((lines.joined(separator: "\n") + "\n").utf8)
    return ChatSessionModel(
      chatName: "fixture", cwd: "/work/project", readOnly: false, store: InMemoryChatJournalStore(journal),
      hostLabel: "devbox"
    ) { _, _ in FixtureByteStream(log: log) }
  }

  /// Set by the debug root so the subagent rows open already expanded.
  nonisolated(unsafe) static var openSubagents = false

  private static let subagentBrief = """
  Check that the migration is safe to run twice.

  - read `db/migrate.ts` and list every statement that is not idempotent
  - run the migration test suite and report failures
  - do not edit any file outside `db/`

  Reply with a short report: what you checked, what failed, what you changed.
  """

  /// A foreground and a background subagent between ordinary tool rows. The background one is still
  /// running when the log ends.
  @MainActor
  static func subagentsModel() -> ChatSessionModel {
    var lines: [String] = [
      update(["sessionUpdate": "session_info_update", "title": "Migration check"]),
      update(tool("m1", "Read db/migrate.ts", kind: "read", status: "completed", text: "export async function migrate() {}")),
      update(tool("a1", "Task", kind: "think", status: "pending", toolName: "Agent", input: [:])),
      update(tool("a1", "run the migration check", kind: "think", status: "in_progress", update: true, toolName: "Agent", input: ["description": "run the migration check"])),
      update(tool("a1", "run the migration check", kind: "think", status: "in_progress", update: true, toolName: "Agent", input: ["description": "run the migration check", "model": "sonnet"])),
      update(tool("a1", "run the migration check", kind: "think", status: "in_progress", update: true, toolName: "Agent", input: ["description": "run the migration check", "model": "sonnet", "prompt": subagentBrief])),
      update(tool("c1", "Read db/migrate.ts", kind: "read", status: "completed", text: "export async function migrate() {}", parent: "a1")),
      update(tool("c2", "bun test db/migrate.test.ts", kind: "execute", status: "completed",
        text: "```console\n✓ creates the tables\n✗ runs twice without error\n\n 1 pass, 1 fail\n```", parent: "a1")),
      update(tool("c3", "Edit src/fetch.ts", kind: "edit", status: "completed", diff: editDiff, parent: "a1")),
      update(tool("c4", "WebSearch: sql create table if not exists", kind: "fetch", status: "completed", text: "3 results", parent: "a1")),
      update(tool("a1", "run the migration check", kind: "think", status: "completed",
        text: "The migration was **not** safe to run twice: one `CREATE TABLE` lacked `IF NOT EXISTS`.\n\n- fixed in `db/migrate.ts`\n- the suite now passes (2 of 2)", update: true, toolName: "Agent")),
      message("The check found one non-idempotent statement and fixed it. I'll also have a background agent audit the seed scripts."),
      update(tool("m2", "bun test", kind: "execute", status: "completed", text: "```console\n 2 pass, 0 fail\n```")),
      update(tool("b1", "Task", kind: "think", status: "pending", toolName: "Agent", input: [:])),
      update(tool("b1", "audit the seed scripts", kind: "think", status: "completed",
        text: "Async agent launched successfully. (This tool result is internal metadata for the host.)\nagentId: agent-b1", update: true, toolName: "Agent",
        input: ["description": "audit the seed scripts", "model": "haiku", "run_in_background": true, "prompt": "List the seed scripts that insert without a conflict clause."])),
      update(tool("d1", "Read db/seed.ts", kind: "read", status: "completed", text: "export const seed = []", parent: "b1")),
      update(tool("d2", "grep -n insert db/seed.ts", kind: "execute", status: "completed", text: "12: insert into users", parent: "b1")),
      update(tool("d3", "Read db/seed-users.ts", kind: "read", status: "in_progress", parent: "b1")),
    ]
    lines.append(update(["sessionUpdate": "usage_update", "used": 30_000, "size": 1_000_000]))
    let log = Data((lines.joined(separator: "\n") + "\n").utf8)
    var journal = ChatJournal()
    journal.sessionId = "sess-1"
    journal.nextRequestId = 4
    journal.entries = [.init(kind: .prompt, offset: 0, text: "Check that the migration is safe to run twice.")]
    return ChatSessionModel(
      chatName: "fixture", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(journal)
    ) { _, _ in FixtureByteStream(log: log) }
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
      text: "```console\n✓ retries a 503 then succeeds\n✓ does not retry a 404\n\n 2 pass, 0 fail\n```", update: false)),
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
  static let dripChunks: [String] = dripChunks(requestId: 3)

  static func dripChunks(requestId: Int) -> [String] {
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
    chunks.append(json(["jsonrpc": "2.0", "id": requestId, "result": ["stopReason": "end_turn"]]))
    return chunks
  }

  /// A long finished turn, rendered whole: grouped tool rows and plenty of prose.
  @MainActor
  static func longModel(steps: Int = 6, replyAfter: Double? = nil) -> ChatSessionModel {
    var lines: [String] = [
      update(["sessionUpdate": "session_info_update", "title": "Chat feature"]),
      update(tool("t1", "Edit apps/tether/README.md", kind: "edit", status: "completed")),
      update(tool("t2", "ls -la /work/project/.codegraph", kind: "execute", status: "completed", text: "total 8")),
      update(tool("t3", "Read src/fetch.ts", kind: "read", status: "completed", text: "export async function fetchJSON")),
      update(["sessionUpdate": "usage_update", "used": 41_250, "size": 1_000_000]),
      message("Edited `apps/tether/README.md` line 3: \"the v5 SSH host\" is now \"the SSH host\". It's uncommitted. Revert with `git checkout apps/tether/README.md`.\n\nThe `ship:scout` subagent is exploring the repo in the background. I'll relay its report when it finishes."),
      message("\n\n## Entry points\n\n- iOS and Mac Catalyst: `clients/apple/TetherIOS` is the app target, with `TetherKit` holding the SSH transport and every screen\n- Windows and Linux: `clients/desktop/` is one Rust workspace with a Slint UI\n- Host side: `apps/tether/` is a small Go tool for encrypted push\n\n"),
    ]
    for step in 1...steps {
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
    ) { _, _ in
      guard let replyAfter else { return FixtureByteStream(log: log) }
      return AnswerOnPromptStream(log: log, chunks: dripChunks(requestId: 4), after: replyAfter)
    }
  }

  /// A long transcript with the composer focused; `ChatView` types a draft and sends it, and the
  /// agent stays silent for `replyAfter` seconds before streaming a long reply.
  @MainActor
  static func sendModel() -> ChatSessionModel {
    let after = Double(ProcessInfo.processInfo.environment["TETHER_DEBUG_REPLY_AFTER"] ?? "") ?? 8
    return longModel(steps: 14, replyAfter: after)
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
      store: InMemoryChatJournalStore(journal),
      listFiles: {
        [
          "README.md", "Package.swift", "src/fetch.ts", "src/fetch.test.ts", "src/main.ts", "src/retry/backoff.ts",
          "src/retry/policy.ts", "docs/guide/main-loop.md", "scripts/make-release.sh", "assets/images/logo-main.png",
        ].joined(separator: "\n")
      }
    ) { _, _ in FixtureByteStream(log: log) }
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
    ) { _, _ in DripByteStream(chunks: dripChunks) }
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
    ) { _, _ in FixtureByteStream(log: log) }
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

/// Hands over its log, then stays silent until a prompt is written, waits `after` seconds and drips `chunks`.
final class AnswerOnPromptStream: TerminalByteStream, @unchecked Sendable {
  private let log: FixtureByteStream
  private let drip: DripByteStream
  private let after: UInt64
  private let lock = NSLock()
  private var prompted = false
  private var logDone = false
  private var answering = false

  init(log: Data, chunks: [String], after: Double) {
    self.log = FixtureByteStream(log: log)
    drip = DripByteStream(chunks: chunks)
    self.after = UInt64(after * 1_000_000_000)
  }

  func read() async throws -> Data? {
    lock.lock()
    let first = !logDone
    logDone = true
    lock.unlock()
    if first { return try await log.read() }
    while true {
      lock.lock()
      let ready = prompted
      lock.unlock()
      if ready { break }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    lock.lock()
    let wait = !answering
    answering = true
    lock.unlock()
    if wait { try await Task.sleep(nanoseconds: after) }
    return try await drip.read()
  }

  func write(_ bytes: Data) async throws {
    if String(decoding: bytes, as: UTF8.self).contains("session/prompt") {
      lock.lock()
      prompted = true
      lock.unlock()
    }
  }

  func close() async {
    await log.close()
    await drip.close()
  }
}

/// DEBUG root for screenshots: the chat screen alone, over the fixture.
public struct ChatFixtureRoot: View {
  @State private var model: ChatSessionModel

  private let listMode: Bool
  @State private var listModel = ChatListModel(hostName: "devbox", exec: { _ in
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
    ChatFixture.openQuestionOther = mode == "question-other"
    ChatFixture.planMode = mode
    listMode = mode == "list"
    let initial: ChatSessionModel
    switch mode {
    case "question", "question-other": initial = ChatFixture.questionModel(multi: mode == "question-other")
    case "question-multi": initial = ChatFixture.questionModel(multi: true)
    case "question-answered": initial = ChatFixture.questionModel(answered: true)
    case "plan", "plan-more", "plan-sheet": initial = ChatFixture.planModel()
    case "queue", "clear", "signedout": initial = ChatFixture.contextModel(mode)
    case "stream": initial = ChatFixture.streamModel()
    case "keyboard", "scrolledup": initial = ChatFixture.longModel()
    case "send": initial = ChatFixture.sendModel()
    case "subagents", "subagents-open", "subagents-open-top":
      ChatFixture.openSubagents = mode != "subagents"
      initial = ChatFixture.subagentsModel()
    case "controls", "controls-sheet", "slash", "attach", "mention", "mention-all": initial = ChatFixture.controlsModel()
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
          model: model, focusComposer: mode == "keyboard" || mode == "slash" || mode == "send" || mode.hasPrefix("mention"), startAtTop: mode == "scrolledup" || mode == "subagents-open-top",
          initialDraft: mode == "slash" ? "/co" : mode == "mention" ? "Look at @ma" : mode == "mention-all" ? "Compare @" : mode == "attach" ? "Compare these two screenshots" : "",
          openControls: mode == "controls-sheet", seedAttachments: mode == "attach",
          sendDraft: mode == "send" ? ChatFixture.sendDraft : nil)
      }
    }
      .tint(TetherColors.accent)
      .preferredColorScheme(ChromeTheme.shared.isLight ? .light : .dark)
  }
}
#endif
