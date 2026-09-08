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
          text: "I'll add a token-bucket limiter keyed by IP. First, let me read the route.",
          tools: [
            AgentToolCall(
              name: "Read",
              summary: "src/routes/login.ts",
              inputJSON: "{\n  \"file_path\" : \"src/routes/login.ts\"\n}",
              result: "export function login(req, res) {\n  const { email, password } = req.body\n  // ...verify\n}"
            )
          ]
        ),
        AgentMessage(
          role: .assistant,
          text:
            "Here's the limiter, then I'll wire it into the route:\n```ts\nconst bucket = new Map<string, number[]>()\nfunction allow(ip: string) {\n  const now = Date.now()\n  const hits = (bucket.get(ip) ?? []).filter(t => now - t < 900_000)\n  hits.push(now)\n  bucket.set(ip, hits)\n  return hits.length <= 5\n}\n```",
          tools: [
            AgentToolCall(
              name: "Edit",
              summary: "src/routes/login.ts",
              inputJSON: "{ \"file_path\": \"src/routes/login.ts\" }",
              result: "Applied 1 edit.",
              diff:
                "@@ -1,4 +1,7 @@\n export function login(req, res) {\n+  if (!allow(req.ip)) {\n+    return res.status(429).json({ error: 'too many attempts' })\n+  }\n   const { email, password } = req.body\n   // ...verify\n }"
            )
          ]
        ),
        AgentMessage(
          role: .assistant,
          text:
            "Done. Login now allows **5 attempts per 15 minutes** per IP and returns `429` after that. Want me to add a test?",
          isStreaming: true
        ),
      ]
      m.turn = .streaming
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
