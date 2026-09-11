#if DEBUG
  import Foundation

  /// A fake host for the agent chat. It turns the model's outbound prompts into
  /// the same `agent.*` frame sequence a real server streams back — prose, a
  /// tool call, its result, more prose, then `agent.done` with the turn's usage —
  /// and can push a turn nobody asked for. Used by `-agentDemo live|liveLong`
  /// so a UI test can drive a whole conversation with no server in the loop.
  ///
  /// Every emitted string carries a marker (`[t1]`, `INBOUND`, `[approved]`) so
  /// a test asserts on specific content instead of "some text appeared".
  @MainActor final class AgentChatScript {
    let model: AgentChatModel
    private var seq = 0
    private var turns = 0
    private var started = false
    private let arriveAfter: Double?
    private var pendingReqId: String?

    /// Boxed because the model's `send` is fixed at init and has to reach a
    /// script that does not exist yet.
    private final class Relay {
      var handle: ((AgentOutbound) -> Void)?
    }

    init(seeded: Bool, arriveAfter: Double?) {
      self.arriveAfter = arriveAfter
      let relay = Relay()
      model = AgentChatModel(
        sessionId: seeded ? "live-long" : "live",
        cwd: "/home/sam/sites/tether",
        send: { out in MainActor.assumeIsolated { relay.handle?(out) } })
      if seeded {
        model.messages = AgentChatSeed.longConversation().messages
        model.turn = .idle
      }
      model.applyStatus(
        model: "claude-opus-4-8",
        fiveHour: UsageWindow(utilization: 42),
        sevenDay: UsageWindow(utilization: 78))
      relay.handle = { [weak self] out in self?.handle(out) }
    }

    /// Idempotent: `onAppear` fires again on every re-layout, and the unsolicited
    /// turn must be scheduled exactly once.
    func start() {
      guard !started else { return }
      started = true
      guard let delay = arriveAfter else { return }
      Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        await self?.arrive()
      }
    }

    private func next() -> Int {
      seq += 1
      return seq
    }

    private func handle(_ out: AgentOutbound) {
      switch out {
      case let .prompt(text):
        turns += 1
        let turn = turns
        Task { @MainActor [weak self] in await self?.answer(text, turn: turn) }
      case .interrupt:
        model.apply(.agentDelta(seq: next(), text: "\n\n_Interrupted._"))
        model.apply(.agentDone(seq: next(), cost: 0, inputTokens: 0, outputTokens: 0))
      case let .permission(reqId, decision):
        guard reqId == pendingReqId else { return }
        pendingReqId = nil
        Task { @MainActor [weak self] in await self?.resolve(decision) }
      case let .model(name):
        model.applyStatus(model: name)
      case .listSessions:
        break
      }
    }

    private func answer(_ prompt: String, turn: Int) async {
      let tag = "[t\(turn)]"
      await step(0.35)
      model.apply(.agentDelta(seq: next(), text: "On it \(tag). Reading the route first."))
      await step(0.35)
      model.apply(.agentDelta(seq: next(), text: " Then I'll add the limiter."))
      // A prompt that would run something destructive stops for approval instead
      // of finishing the turn — the sheet path, driven from the same script.
      if prompt.lowercased().contains("install") {
        // A UUID string on purpose: the client parses reqId with
        // `UUID(uuidString:) ?? UUID()` and echoes the parsed value back, so a
        // non-UUID id never round-trips and the decision is dropped.
        let reqId = UUID().uuidString
        pendingReqId = reqId
        await step(0.3)
        model.apply(
          .agentPermissionReq(
            reqId: reqId, name: "Bash",
            input: "{\n  \"command\" : \"rm -rf node_modules && bun install\"\n}"))
        return
      }
      await step(0.4)
      model.apply(
        .agentTool(
          seq: next(), name: "Read",
          input: "{\n  \"file_path\" : \"src/routes/login.ts\"\n}"))
      await step(0.4)
      model.apply(
        .agentToolResult(
          seq: next(),
          text: "export function login(req, res) {\n  const { email, password } = req.body\n}",
          isError: false))
      await step(0.4)
      model.apply(
        .agentDelta(
          seq: next(),
          text: "\n\nHere it is \(tag):\n```ts\nfunction allow(ip: string) {\n"
            + "  return hits(ip).length <= 5\n}\n```\nDone \(tag)."))
      await step(0.35)
      model.apply(
        .agentDone(seq: next(), cost: 0.004 * Double(turn), inputTokens: 12_000, outputTokens: 480))
    }

    private func resolve(_ decision: String) async {
      guard decision != "deny" else {
        model.apply(.agentDelta(seq: next(), text: "\n\nSkipped the install. [denied]"))
        model.apply(.agentDone(seq: next(), cost: 0, inputTokens: 0, outputTokens: 0))
        return
      }
      await step(0.3)
      model.apply(
        .agentTool(
          seq: next(), name: "Bash",
          input: "{\n  \"command\" : \"rm -rf node_modules && bun install\"\n}"))
      await step(0.5)
      model.apply(
        .agentToolResult(seq: next(), text: "installed 412 packages [approved]", isError: false))
      await step(0.3)
      model.apply(.agentDelta(seq: next(), text: "\n\nReinstalled. [approved]"))
      model.apply(.agentDone(seq: next(), cost: 0.002, inputTokens: 900, outputTokens: 120))
    }

    /// A turn the user did not ask for — the "new data from the server" case that
    /// decides whether the transcript follows the foot or holds the user's place.
    private func arrive() async {
      model.apply(.agentUser(seq: next(), text: "INBOUND prompt from another device"))
      await step(0.3)
      model.apply(.agentDelta(seq: next(), text: "INBOUND turn: picking this up now."))
      await step(0.4)
      model.apply(
        .agentTool(seq: next(), name: "Grep", input: "{\n  \"pattern\" : \"INBOUND\"\n}"))
      await step(0.4)
      model.apply(.agentToolResult(seq: next(), text: "3 matches", isError: false))
      await step(0.4)
      model.apply(.agentDelta(seq: next(), text: "\n\nINBOUND turn finished."))
      model.apply(.agentDone(seq: next(), cost: 0.001, inputTokens: 800, outputTokens: 90))
    }

    private func step(_ seconds: Double) async {
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
  }
#endif
