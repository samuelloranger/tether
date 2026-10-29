import XCTest
@testable import TetherKit

final class ChatWorkflowTests: XCTestCase {
  private func runLine(
    call: String = "toolu_1", status: String = "running", title: String = "review", summary: String? = nil,
    phases: String = #"[{"title":"Scan","agents":[{"label":"a","state":"done","startedAt":1000,"endedAt":1060},{"label":"b","state":"running","startedAt":1010,"activity":"Bash: ls"}]},{"title":"Merge","agents":[]}]"#
  ) -> String {
    let tail = summary.map { #","summary":"\#($0)","endedAt":1100"# } ?? ""
    return #"{"toolCallId":"\#(call)","runId":"wf_x","title":"\#(title)","status":"\#(status)","startedAt":990,"agents":{"total":2,"running":1,"done":1},"phases":\#(phases)\#(tail)}"#
  }

  private func call(_ id: String = "toolu_1", name: String? = "Workflow", status: ACPToolStatus = .completed) -> ChatToolCall {
    var fields = ACPToolFields(id: id)
    fields.title = "Workflow"
    fields.status = status
    fields.toolName = name
    return ChatToolCall(fields)
  }

  // MARK: Parsing

  func test_a_run_line_parses_with_phases_agents_and_times() throws {
    let result = ChatWorkflowListing.parse(runLine())
    XCTAssertFalse(result.unsupported)
    let run = try XCTUnwrap(result.runs.first)
    XCTAssertEqual(run.toolCallId, "toolu_1")
    XCTAssertEqual(run.title, "review")
    XCTAssertEqual(run.status, .running)
    XCTAssertEqual(run.startedAt, Date(timeIntervalSince1970: 990))
    XCTAssertEqual(run.phases.map(\.title), ["Scan", "Merge"])
    XCTAssertEqual(run.phases[0].agents.map(\.isDone), [true, false])
    XCTAssertEqual(run.phases[0].agents[1].activity, "Bash: ls")
    XCTAssertEqual(run.phases[0].agents[0].endedAt, Date(timeIntervalSince1970: 1060))
    XCTAssertEqual(run.doneCount, 1)
    XCTAssertEqual(run.totalCount, 2)
  }

  func test_an_ended_run_keeps_the_status_word_and_summary() throws {
    let done = try XCTUnwrap(ChatWorkflowListing.parse(runLine(status: "completed", summary: "All good")).runs.first)
    XCTAssertEqual(done.status, .completed)
    XCTAssertEqual(done.summary, "All good")
    XCTAssertEqual(ChatWorkflowText.statusWord(done), "done")
    let killed = try XCTUnwrap(ChatWorkflowListing.parse(runLine(status: "killed")).runs.first)
    XCTAssertEqual(killed.status, .ended("killed"))
    XCTAssertEqual(ChatWorkflowText.statusWord(killed), "killed")
  }

  func test_an_old_host_reads_as_unsupported_but_no_runs_does_not() {
    XCTAssertTrue(ChatWorkflowListing.parse(#"tether: unknown acp command "workflows""#).unsupported)
    XCTAssertTrue(ChatWorkflowListing.parse("sh: tether: command not found").unsupported)
    XCTAssertFalse(ChatWorkflowListing.parse("").unsupported)
    XCTAssertFalse(ChatWorkflowListing.parse("\n").unsupported)
    XCTAssertFalse(ChatWorkflowListing.parse("note\n" + runLine()).unsupported)
  }

  func test_the_command_quotes_the_session_id() {
    let command = ChatWorkflowListing.command(sessionId: "a b'c")
    XCTAssertTrue(command.contains("tether acp workflows --session "))
    XCTAssertFalse(command.contains("--session a b'c"))
    XCTAssertTrue(command.hasSuffix("--json 2>&1"))
  }

  // MARK: Strip text

  func test_the_strip_names_the_title_phase_and_agent_count() throws {
    let run = try XCTUnwrap(ChatWorkflowListing.parse(runLine()).runs.first)
    XCTAssertEqual(ChatWorkflowText.strip(run), "review \u{00B7} Scan \u{00B7} 1/2 agents")
  }

  func test_the_phase_is_the_first_with_an_unfinished_agent_else_the_last_with_agents() throws {
    let allDone = #"[{"title":"A","agents":[{"label":"x","state":"done"}]},{"title":"B","agents":[{"label":"y","state":"done"}]},{"title":"C","agents":[]}]"#
    let run = try XCTUnwrap(ChatWorkflowListing.parse(runLine(phases: allDone)).runs.first)
    XCTAssertEqual(run.currentPhase?.title, "B")
    let bare = try XCTUnwrap(ChatWorkflowListing.parse(runLine(phases: "[]")).runs.first)
    XCTAssertEqual(ChatWorkflowText.strip(bare), "review")
  }

  func test_elapsed_reads_compactly_and_a_finished_agent_stops_counting() {
    XCTAssertEqual(ChatWorkflowText.elapsed(45), "45s")
    XCTAssertEqual(ChatWorkflowText.elapsed(185), "3m 05s")
    XCTAssertEqual(ChatWorkflowText.elapsed(3720), "1h 02m")
    XCTAssertEqual(ChatWorkflowText.elapsed(-3), "0s")
    let start = Date(timeIntervalSince1970: 1000)
    let done = ChatWorkflowRun.Agent(label: "a", isDone: true, startedAt: start, endedAt: start + 60)
    let running = ChatWorkflowRun.Agent(label: "b", isDone: false, startedAt: start)
    XCTAssertEqual(ChatWorkflowText.elapsed(done, now: start + 500), "1m 00s")
    XCTAssertEqual(ChatWorkflowText.elapsed(running, now: start + 500), "8m 20s")
    XCTAssertNil(ChatWorkflowText.elapsed(.init(label: "c", isDone: false), now: start))
  }

  // MARK: Tool calls

  func test_only_the_workflow_tool_is_marked() {
    XCTAssertEqual(call().isWorkflow, true)
    XCTAssertNil(call(name: "Bash").isWorkflow)
    XCTAssertNil(call(name: nil).isWorkflow)
  }

  func test_a_snapshot_from_before_the_mark_still_decodes() throws {
    let old = #"{"id":"t","title":"Workflow","kind":"other","status":"completed","images":[],"children":[]}"#
    let decoded = try JSONDecoder().decode(ChatToolCall.self, from: Data(old.utf8))
    XCTAssertNil(decoded.isWorkflow)
  }

  // MARK: Tracker

  func test_polling_continues_while_a_run_runs_and_stops_when_it_ends() {
    var tracker = ChatWorkflowTracker()
    let calls = [call()]
    XCTAssertTrue(tracker.needsPolling(calls: calls))
    tracker.apply(output: runLine(), calls: calls)
    XCTAssertTrue(tracker.needsPolling(calls: calls))
    XCTAssertEqual(tracker.running.count, 1)
    tracker.apply(output: runLine(status: "completed", summary: "ok"), calls: calls)
    XCTAssertFalse(tracker.needsPolling(calls: calls))
    XCTAssertTrue(tracker.running.isEmpty)
  }

  func test_no_workflow_call_means_no_polling() {
    XCTAssertFalse(ChatWorkflowTracker().needsPolling(calls: [call(name: "Bash")]))
    XCTAssertFalse(ChatWorkflowTracker().needsPolling(calls: []))
  }

  func test_a_failed_launch_is_not_polled_for() {
    XCTAssertFalse(ChatWorkflowTracker().needsPolling(calls: [call(status: .failed)]))
  }

  func test_a_call_the_host_never_lists_stops_after_a_few_answers() {
    var tracker = ChatWorkflowTracker()
    let calls = [call()]
    for _ in 0..<ChatWorkflowTracker.maxMisses {
      XCTAssertTrue(tracker.needsPolling(calls: calls))
      tracker.apply(output: "", calls: calls)
    }
    XCTAssertFalse(tracker.needsPolling(calls: calls))
  }

  func test_an_old_host_stops_the_polling_for_good_and_rows_keep_the_acp_status() {
    var tracker = ChatWorkflowTracker()
    let calls = [call()]
    tracker.apply(output: #"tether: unknown acp command "workflows""#, calls: calls)
    XCTAssertFalse(tracker.supported)
    XCTAssertFalse(tracker.needsPolling(calls: calls))
    XCTAssertNil(tracker.rowStatus(forCall: "toolu_1"))
  }

  func test_a_failed_ask_changes_nothing() {
    var tracker = ChatWorkflowTracker()
    tracker.apply(output: runLine(), calls: [call()])
    tracker.apply(output: nil, calls: [call()])
    XCTAssertEqual(tracker.runs.count, 1)
    XCTAssertTrue(tracker.supported)
  }

  func test_the_workflow_row_runs_until_the_host_reports_the_end() {
    var tracker = ChatWorkflowTracker()
    let item = ChatItem(id: 1, kind: .tool(call()))
    let other = ChatItem(id: 2, kind: .tool(call("toolu_2", name: "Bash")))
    func status(_ items: [ChatItem], _ index: Int) -> ACPToolStatus? {
      if case let .tool(call) = items[index].kind { return call.status }
      return nil
    }
    XCTAssertEqual(status(tracker.display([item, other]), 0), .completed)
    tracker.apply(output: runLine(), calls: [call()])
    XCTAssertEqual(status(tracker.display([item, other]), 0), .inProgress)
    XCTAssertEqual(status(tracker.display([item, other]), 1), .completed)
    tracker.apply(output: runLine(status: "completed", summary: "ok"), calls: [call()])
    XCTAssertEqual(status(tracker.display([item]), 0), .completed)
    tracker.apply(output: runLine(status: "failed", summary: "no"), calls: [call()])
    XCTAssertEqual(status(tracker.display([item]), 0), .failed)
  }
}

@MainActor
final class ChatWorkflowModelTests: XCTestCase {
  private final class Asks: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [String] = []
    private var answers: [String?]
    init(_ answers: [String?]) { self.answers = answers }
    var sessionIds: [String] { lock.lock(); defer { lock.unlock() }; return ids }
    func next(_ id: String) -> String? {
      lock.lock(); defer { lock.unlock() }
      ids.append(id)
      return answers.count > 1 ? answers.removeFirst() : answers.first ?? nil
    }
  }

  private let launch = [
    #"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call","toolCallId":"toolu_w","title":"Workflow","kind":"other","status":"completed","_meta":{"claudeCode":{"toolName":"Workflow"}}}}}"#,
  ]

  private func run(_ status: String) -> String {
    #"{"toolCallId":"toolu_w","runId":"wf_x","title":"review","status":"\#(status)","phases":[{"title":"Scan","agents":[{"label":"a","state":"running"}]}]}"#
  }

  private func model(_ stream: ScriptedByteStream, asks: Asks, interval: Duration = .milliseconds(20)) -> ChatSessionModel {
    ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false, store: InMemoryChatJournalStore(ACPFixture.journal),
      workflows: { asks.next($0) }, workflowInterval: interval
    ) { _, _ in stream }
  }

  func test_a_workflow_call_is_polled_until_the_host_reports_its_end() async {
    let asks = Asks([run("running"), run("running"), run("completed")])
    let stream = ScriptedByteStream()
    let model = model(stream, asks: asks)
    Task { await model.connect() }
    stream.push(ACPFixture.log(extra: launch))
    let sawRunning = await eventually(timeout: 4) { model.runningWorkflows.count == 1 }
    XCTAssertTrue(sawRunning)
    let ended = await eventually(timeout: 4) { model.runningWorkflows.isEmpty && model.workflowTracker.runs.first?.status == .completed }
    XCTAssertTrue(ended)
    let settled = asks.sessionIds.count
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(asks.sessionIds.count, settled, "no more asks once the run is over")
    XCTAssertTrue(asks.sessionIds.allSatisfy { !$0.isEmpty })
    model.leave()
  }

  func test_a_chat_without_a_workflow_call_never_asks() async {
    let asks = Asks([run("running")])
    let stream = ScriptedByteStream()
    let model = model(stream, asks: asks)
    Task { await model.connect() }
    stream.push(ACPFixture.log())
    let live = await eventually(timeout: 4) { model.link.phase == .live }
    XCTAssertTrue(live)
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertTrue(asks.sessionIds.isEmpty)
    model.leave()
  }

  func test_an_old_host_is_asked_once() async {
    let asks = Asks([#"tether: unknown acp command "workflows""#])
    let stream = ScriptedByteStream()
    let model = model(stream, asks: asks)
    Task { await model.connect() }
    stream.push(ACPFixture.log(extra: launch))
    let unsupported = await eventually(timeout: 4) { !model.workflowTracker.supported }
    XCTAssertTrue(unsupported)
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(asks.sessionIds.count, 1)
    model.leave()
  }
}
