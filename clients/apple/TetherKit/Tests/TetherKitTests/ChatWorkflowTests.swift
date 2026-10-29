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
    XCTAssertTrue(ChatWorkflowListing.parse("tether: usage: acp attach|answer|answers|ls|status|sessions|kill").unsupported)
    XCTAssertFalse(ChatWorkflowListing.parse("").unsupported)
    XCTAssertFalse(ChatWorkflowListing.parse("\n").unsupported)
    XCTAssertFalse(ChatWorkflowListing.parse("note\n" + runLine()).unsupported)
  }

  func test_a_transient_failure_is_a_failed_poll_not_an_old_host() {
    for text in ["ssh: connect to host failed", "sh: tether: command not found", "Killed", "tether: open x: permission denied"] {
      let result = ChatWorkflowListing.parse(text)
      XCTAssertFalse(result.unsupported, text)
      XCTAssertTrue(result.failed, text)
    }
    XCTAssertFalse(ChatWorkflowListing.parse("").failed)
    XCTAssertFalse(ChatWorkflowListing.parse(runLine()).failed)
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
    let done = ChatWorkflowRun.Agent(label: "a", state: .done, startedAt: start, endedAt: start + 60)
    let running = ChatWorkflowRun.Agent(label: "b", state: .running, startedAt: start)
    XCTAssertEqual(ChatWorkflowText.elapsed(done, now: start + 500), "1m 00s")
    XCTAssertEqual(ChatWorkflowText.elapsed(running, now: start + 500), "8m 20s")
    XCTAssertNil(ChatWorkflowText.elapsed(.init(label: "c", state: .running), now: start))
    var stopped = running
    stopped.state = .stopped
    XCTAssertNil(ChatWorkflowText.elapsed(stopped, now: start + 500), "a stopped agent with no end does not keep counting")
    stopped.endedAt = start + 30
    XCTAssertEqual(ChatWorkflowText.elapsed(stopped, now: start + 500), "30s")
  }

  func test_agents_of_an_ended_run_are_stopped_and_not_counted_as_running() throws {
    let phases = #"[{"title":"A","agents":[{"label":"x","state":"done"},{"label":"y","state":"stopped"},{"label":"z","state":"running"}]}]"#
    let ended = try XCTUnwrap(ChatWorkflowListing.parse(runLine(status: "killed", phases: phases)).runs.first)
    XCTAssertEqual(ended.phases[0].agents.map(\.state), [.done, .stopped, .stopped])
    XCTAssertEqual(ended.runningCount, 0)
    XCTAssertEqual(ended.doneCount, 1)
    XCTAssertEqual(ended.totalCount, 3)
    let live = try XCTUnwrap(ChatWorkflowListing.parse(runLine(phases: phases)).runs.first)
    XCTAssertEqual(live.phases[0].agents.map(\.state), [.done, .stopped, .running])
    XCTAssertEqual(live.runningCount, 1)
  }

  func test_a_run_with_no_end_notice_says_how_long_it_has_been_quiet_but_is_not_done() throws {
    let now = Date(timeIntervalSince1970: 100_000)
    var run = try XCTUnwrap(ChatWorkflowListing.parse(runLine()).runs.first)
    XCTAssertNil(ChatWorkflowText.quiet(run, now: now), "no host timestamp, nothing to say")
    run.lastActivityAt = now - 599
    XCTAssertNil(ChatWorkflowText.quiet(run, now: now))
    run.lastActivityAt = now - 12 * 60 - 5
    XCTAssertEqual(ChatWorkflowText.quiet(run, now: now), "no activity for 12m")
    XCTAssertEqual(ChatWorkflowText.strip(run, now: now), "review \u{00B7} no activity for 12m \u{00B7} 1/2 agents")
    XCTAssertEqual(ChatWorkflowText.statusWord(run), "running")
    XCTAssertTrue(run.isRunning)
    run.status = .completed
    XCTAssertNil(ChatWorkflowText.quiet(run, now: now), "an ended run is not quiet, it is over")
  }

  func test_last_activity_is_read_from_the_host() throws {
    let line = runLine().replacingOccurrences(of: #""status":"running""#, with: #""status":"running","lastActivityAt":1234"#)
    XCTAssertEqual(ChatWorkflowListing.parse(line).runs.first?.lastActivityAt, Date(timeIntervalSince1970: 1234))
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

  func test_polling_slows_after_two_quiet_minutes_and_speeds_up_on_any_change() {
    var tracker = ChatWorkflowTracker()
    let calls = [call()]
    let t0 = Date(timeIntervalSince1970: 1000)
    let base = Duration.seconds(5)
    XCTAssertEqual(tracker.interval(base: base, now: t0), base)
    tracker.apply(output: runLine(), calls: calls, now: t0)
    XCTAssertEqual(tracker.interval(base: base, now: t0 + 119), base)
    XCTAssertEqual(tracker.interval(base: base, now: t0 + 121), .seconds(30))
    tracker.apply(output: runLine(), calls: calls, now: t0 + 125)
    XCTAssertEqual(tracker.interval(base: base, now: t0 + 130), .seconds(30), "the same answer is not a change")
    tracker.apply(output: nil, calls: calls, now: t0 + 135)
    tracker.apply(output: "ssh: connect failed", calls: calls, now: t0 + 140)
    XCTAssertEqual(tracker.interval(base: base, now: t0 + 145), .seconds(30), "a failed poll is not a change either")
    let moved = runLine(phases: #"[{"title":"Merge","agents":[{"label":"c","state":"running"}]}]"#)
    tracker.apply(output: moved, calls: calls, now: t0 + 150)
    XCTAssertEqual(tracker.interval(base: base, now: t0 + 155), base)
    XCTAssertEqual(tracker.interval(base: base, now: t0 + 150 + 121), .seconds(30))
  }

  func test_a_transient_failure_does_not_stop_the_polling() {
    var tracker = ChatWorkflowTracker()
    let calls = [call()]
    tracker.apply(output: "ssh: connection reset", calls: calls)
    XCTAssertTrue(tracker.supported)
    XCTAssertTrue(tracker.needsPolling(calls: calls))
    tracker.apply(output: runLine(), calls: calls)
    tracker.apply(output: "Killed", calls: calls)
    XCTAssertEqual(tracker.runs.count, 1, "the last good answer stands")
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

  private final class Gauge: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0
    private(set) var peak = 0
    private(set) var count = 0
    func enter() { lock.lock(); current += 1; count += 1; peak = max(peak, current); lock.unlock() }
    func leave() { lock.lock(); current -= 1; lock.unlock() }
    var asks: Int { lock.lock(); defer { lock.unlock() }; return count }
  }

  private func gaugedModel(_ streams: [ScriptedByteStream], gauge: Gauge, run: String) -> ChatSessionModel {
    let queue = LockedBox(streams)
    return ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false, store: InMemoryChatJournalStore(ACPFixture.journal),
      workflows: { _ in
        gauge.enter()
        defer { gauge.leave() }
        try? await Task.sleep(nanoseconds: 5_000_000)
        return run
      }, workflowInterval: .milliseconds(15)
    ) { _, _ in
      queue.update { $0.isEmpty ? ScriptedByteStream() : $0.removeFirst() }
    }
  }

  func test_polling_stops_on_leave() async {
    let gauge = Gauge()
    let stream = ScriptedByteStream()
    let model = gaugedModel([stream], gauge: gauge, run: run("running"))
    Task { await model.connect() }
    stream.push(ACPFixture.log(extra: launch))
    let asking = await eventually(timeout: 4) { gauge.asks >= 2 }
    XCTAssertTrue(asking)
    model.leave()
    try? await Task.sleep(nanoseconds: 100_000_000)
    let settled = gauge.asks
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(gauge.asks, settled)
  }

  func test_polling_stops_in_the_background_and_a_reconnect_runs_exactly_one_loop() async {
    let gauge = Gauge()
    let first = ScriptedByteStream()
    let second = ScriptedByteStream()
    let model = gaugedModel([first, second], gauge: gauge, run: run("running"))
    Task { await model.connect() }
    first.push(ACPFixture.log(extra: launch))
    let asking = await eventually(timeout: 4) { gauge.asks >= 2 }
    XCTAssertTrue(asking)

    model.sceneEnteredBackground()
    try? await Task.sleep(nanoseconds: 100_000_000)
    let paused = gauge.asks
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertEqual(gauge.asks, paused, "no asks while backgrounded")

    model.sceneBecameActive()
    second.push(ACPFixture.log(extra: launch))
    let resumed = await eventually(timeout: 4) { gauge.asks > paused + 3 }
    XCTAssertTrue(resumed)
    XCTAssertEqual(gauge.peak, 1, "a reconnect never runs two loops at once")
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
