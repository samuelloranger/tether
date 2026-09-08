#if DEBUG
  import SwiftUI

  /// Screenshot / preview harness. Renders the agent-chat surfaces with seeded
  /// data so the UI can be captured on the simulator without a live host.
  /// Launch with `-agentDemo <state>` where state ∈ chat|approval|picker|empty.
  public struct AgentChatDemoRoot: View {
    public init() {}

    public static var launchState: String? {
      let args = ProcessInfo.processInfo.arguments
      guard let i = args.firstIndex(of: "-agentDemo"), i + 1 < args.count else { return nil }
      return args[i + 1]
    }

    public var body: some View {
      DemoFrame(title: title) { content }
    }

    private var state: String { Self.launchState ?? "chat" }
    private var title: String { state == "picker" ? "New chat" : "tether" }

    @ViewBuilder private var content: some View {
      switch state {
      case "approval":
        AgentChatView(model: AgentChatSeed.approving())
      case "picker":
        AgentFolderPicker(folders: AgentChatSeed.folders) { _ in }
      case "empty":
        AgentChatView(model: AgentChatModel(sessionId: "s", cwd: "/home/sam/sites/tether"))
      case "diff":
        ScrollView { AgentToolCard(call: AgentChatSeed.editCall, startExpanded: true).padding(16) }
          .background(TetherColors.background)
      case "scroll":
        // Long, idle transcript for the scroll-stability check: it must NOT move
        // when the keyboard appears or while the composer is being typed into.
        AgentChatView(model: AgentChatSeed.longConversation())
      default:
        AgentChatView(model: AgentChatSeed.conversation())
      }
    }
  }

  /// A lightweight nav bar so screenshots read as a real screen.
  struct DemoFrame<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
      VStack(spacing: 0) {
        HStack(spacing: 10) {
          Image(systemName: "line.3.horizontal")
            .foregroundStyle(TetherColors.textSecondary)
          Text(title)
            .font(.headline)
            .foregroundStyle(TetherColors.textPrimary)
          Spacer()
          Circle().fill(TetherColors.heatWorking).frame(width: 8, height: 8)
          Text("working")
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundStyle(TetherColors.textSecondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(TetherColors.surface)
        .overlay(alignment: .bottom) { Divider().overlay(TetherColors.border) }
        content
      }
      .background(TetherColors.background)
      .preferredColorScheme(.dark)
      // Mirror RootView: the chat lifts its own composer over the keyboard, so
      // the harness must also opt out of SwiftUI's automatic avoidance — else
      // both fire and the composer floats a keyboard-height above the keyboard.
      .ignoresSafeArea(.keyboard, edges: .bottom)
    }
  }

  enum AgentChatSeed {
    static let folders: [AgentFolder] = [
      AgentFolder(name: "tether", path: "~/sites/tether", isRepo: true),
      AgentFolder(name: "vigie", path: "~/sites/vigie", isRepo: true),
      AgentFolder(name: "pricehawk", path: "~/sites/pricehawk", isRepo: true),
      AgentFolder(name: "board", path: "~/sites/board", isRepo: true),
      AgentFolder(name: "sites", path: "~/sites", isRepo: false),
    ]

    static let editCall = AgentToolCall(
      name: "Edit",
      summary: "src/routes/login.ts",
      inputJSON: "{ \"file_path\": \"src/routes/login.ts\" }",
      result: "Applied 1 edit.",
      diff:
        "@@ -1,4 +1,7 @@\n export function login(req, res) {\n+  if (!allow(req.ip)) {\n+    return res.status(429).json({ error: 'too many attempts' })\n+  }\n   const { email, password } = req.body\n   // ...verify\n }"
    )

    @MainActor static func conversation() -> AgentChatModel {
      let m = AgentChatModel(sessionId: "demo", cwd: "/home/sam/sites/tether")
      m.messages = [
        AgentMessage(role: .user, text: "Add a rate limiter to the login route — 5 tries per 15 min."),
        AgentMessage(
          role: .assistant,
          blocks: [
            .text(id: UUID(), "I'll add a token-bucket limiter keyed by IP. First, let me read the route."),
            .tool(
              AgentToolCall(
                name: "Read",
                summary: "src/routes/login.ts",
                inputJSON: "{\n  \"file_path\" : \"src/routes/login.ts\"\n}",
                result:
                  "export function login(req, res) {\n  const { email, password } = req.body\n  // ...verify\n}"
              )
            ),
            .text(
              id: UUID(),
              "Here's the limiter, then I'll wire it into the route:\n```ts\nconst bucket = new Map<string, number[]>()\nfunction allow(ip: string) {\n  const now = Date.now()\n  const hits = (bucket.get(ip) ?? []).filter(t => now - t < 900_000)\n  hits.push(now)\n  bucket.set(ip, hits)\n  return hits.length <= 5\n}\n```"
            ),
            .tool(
              AgentToolCall(
                name: "Edit",
                summary: "src/routes/login.ts",
                inputJSON: "{ \"file_path\": \"src/routes/login.ts\" }",
                result: "Applied 1 edit.",
                diff:
                  "@@ -1,4 +1,7 @@\n export function login(req, res) {\n+  if (!allow(req.ip)) {\n+    return res.status(429).json({ error: 'too many attempts' })\n+  }\n   const { email, password } = req.body\n   // ...verify\n }"
              )
            ),
            .text(
              id: UUID(),
              "Done. Login now allows **5 attempts per 15 minutes** per IP and returns `429` after that. Want me to add a test?"
            ),
          ],
          isStreaming: true
        ),
      ]
      m.turn = .streaming
      return m
    }

    /// An idle multi-turn transcript tall enough to overflow the screen, so a
    /// scroll away from the foot is visible and can be checked to hold steady.
    @MainActor static func longConversation() -> AgentChatModel {
      let m = AgentChatModel(sessionId: "scroll", cwd: "/home/sam/sites/tether")
      var msgs: [AgentMessage] = []
      let asks = [
        "Add a rate limiter to the login route — 5 tries per 15 min.",
        "Now cover it with a test.",
        "The test is flaky on CI. Look into it.",
        "Good. Wire the limiter into the signup route too.",
        "Add a metrics counter for rejected requests.",
      ]
      for (i, ask) in asks.enumerated() {
        msgs.append(AgentMessage(role: .user, text: ask))
        msgs.append(
          AgentMessage(
            role: .assistant,
            blocks: [
              .text(
                id: UUID(),
                "On it. Here's turn \(i + 1): I read the route, made the change, and verified it. "
                  + "The limiter is a token bucket keyed by IP with a 15-minute window."),
              .tool(
                AgentToolCall(
                  name: i % 2 == 0 ? "Read" : "Edit",
                  summary: "src/routes/login.ts",
                  inputJSON: "{ \"file_path\": \"src/routes/login.ts\" }",
                  result: "Applied \(i + 1) edit(s).",
                  diff:
                    "@@ -1,4 +1,7 @@\n export function login(req, res) {\n+  if (!allow(req.ip)) {\n+    return res.status(429).json({ error: 'too many attempts' })\n+  }\n   const { email, password } = req.body\n }"
                )),
              .text(
                id: UUID(),
                "Done with turn \(i + 1). Everything is green — let me know what's next."),
            ],
            usage: AgentUsage(
              cost: 0.004 * Double(i + 1),
              inputTokens: 12_000 + i * 2_400,
              outputTokens: 480 + i * 90)
          ))
      }
      m.messages = msgs
      m.turn = .idle
      return m
    }

    @MainActor static func approving() -> AgentChatModel {
      let m = conversation()
      m.messages[m.messages.count - 1].isStreaming = false
      m.turn = .idle
      m.pendingApproval = AgentToolCall(
        name: "Bash",
        summary: "rm -rf node_modules && bun install",
        inputJSON:
          "{\n  \"command\" : \"rm -rf node_modules && bun install\",\n  \"description\" : \"Clean reinstall\"\n}"
      )
      return m
    }
  }
#endif
