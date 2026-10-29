import Foundation

/// A background Workflow run as `tether acp workflows` reports it. ACP says nothing after the
/// launch; the host reads the run's progress and end from Claude Code's own session files.
struct ChatWorkflowRun: Equatable, Identifiable, Sendable {
  enum Status: Equatable, Sendable {
    case running, completed
    /// Anything else Claude Code reports (failed, killed, ...), as written.
    case ended(String)
  }

  struct Agent: Equatable, Sendable {
    /// `stopped`: the run ended and this agent never reported a result.
    enum State: Equatable, Sendable { case running, done, stopped }

    var label: String
    var state: State
    var startedAt: Date?
    var endedAt: Date?
    var activity: String?

    var isDone: Bool { state == .done }
  }

  struct Phase: Equatable, Sendable {
    var title: String
    var agents: [Agent]
  }

  var toolCallId: String
  var runId: String
  var title: String
  var description: String?
  var status: Status
  var startedAt: Date?
  var endedAt: Date?
  /// The newest write to the run's files on the host; nil from a host that does not say.
  var lastActivityAt: Date?
  var summary: String?
  var phases: [Phase]

  var id: String { toolCallId }
  var isRunning: Bool { status == .running }
  var agents: [Agent] { phases.flatMap(\.agents) }
  var doneCount: Int { agents.filter(\.isDone).count }
  var totalCount: Int { agents.count }
  var runningCount: Int { agents.filter { $0.state == .running }.count }

  /// The phase to name on the strip: the first with an agent still running, else the last with
  /// agents, else the first listed.
  var currentPhase: Phase? {
    phases.first { $0.agents.contains { $0.state == .running } } ?? phases.last { !$0.agents.isEmpty } ?? phases.first
  }
}

enum ChatWorkflowText {
  /// How long a run with no end notice may be silent before the app says so.
  static let quietAfter: TimeInterval = 600

  /// "no activity for 12m" for a running run whose files have not been written for a while. The
  /// run is still not called done: only the host's end notice says that.
  static func quiet(_ run: ChatWorkflowRun, now: Date) -> String? {
    guard run.isRunning, let last = run.lastActivityAt else { return nil }
    let silent = now.timeIntervalSince(last)
    guard silent >= quietAfter else { return nil }
    return "no activity for \(Int(silent / 60))m"
  }

  /// "<title> · <phase> · 1/2 agents"; a part with nothing to say is left out. A quiet run names
  /// how long it has been quiet instead of its phase.
  static func strip(_ run: ChatWorkflowRun, now: Date = .now) -> String {
    var parts = [run.title]
    if let quiet = quiet(run, now: now) {
      parts.append(quiet)
    } else if let phase = run.currentPhase?.title, !phase.isEmpty {
      parts.append(phase)
    }
    if run.totalCount > 0 { parts.append("\(run.doneCount)/\(run.totalCount) agents") }
    return parts.joined(separator: " \u{00B7} ")
  }

  /// "45s", "3m 05s", "1h 02m".
  static func elapsed(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds))
    if total < 60 { return "\(total)s" }
    if total < 3600 { return "\(total / 60)m \(String(format: "%02d", total % 60))s" }
    return "\(total / 3600)h \(String(format: "%02d", total % 3600 / 60))m"
  }

  /// How long an agent has run, or ran; nil when the host gave no start.
  static func elapsed(_ agent: ChatWorkflowRun.Agent, now: Date) -> String? {
    guard let start = agent.startedAt else { return nil }
    if agent.state == .running { return elapsed(now.timeIntervalSince(start)) }
    return agent.endedAt.map { elapsed($0.timeIntervalSince(start)) }
  }

  static func elapsed(_ run: ChatWorkflowRun, now: Date) -> String? {
    guard let start = run.startedAt else { return nil }
    return elapsed((run.isRunning ? now : (run.endedAt ?? now)).timeIntervalSince(start))
  }

  /// "completed" reads as done; other words are shown as the host wrote them.
  static func statusWord(_ run: ChatWorkflowRun) -> String {
    switch run.status {
    case .running: "running"
    case .completed: "done"
    case let .ended(word): word
    }
  }
}

/// `tether acp workflows --session <id> --json`: one JSON object per run. A host whose tether
/// predates the command prints an error line instead, which reads as `unsupported`.
enum ChatWorkflowListing {
  struct Result: Equatable {
    var runs: [ChatWorkflowRun]
    /// The host answered with its unknown-command or usage text: it has no such command.
    var unsupported: Bool
    /// Output that is neither runs nor that text (a dropped connection, a shell error): one failed poll.
    var failed: Bool
  }

  static func isUnknownCommand(_ output: String) -> Bool {
    let lower = output.lowercased()
    return lower.contains("unknown acp command") || lower.contains("unknown command") || lower.contains("usage:")
  }

  static func command(sessionId: String) -> String {
    "PATH=\"$HOME/.local/bin:$PATH\" tether acp workflows --session \(shellQuote(sessionId)) --json 2>&1"
  }

  static func parse(_ output: String) -> Result {
    var runs: [ChatWorkflowRun] = []
    var stray = false
    for raw in output.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty else { continue }
      guard let run = run(from: line) else {
        stray = true
        continue
      }
      runs.append(run)
    }
    let unrecognised = runs.isEmpty && stray
    return Result(
      runs: runs, unsupported: unrecognised && isUnknownCommand(output), failed: unrecognised && !isUnknownCommand(output))
  }

  private static func run(from line: String) -> ChatWorkflowRun? {
    guard let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
      let call = object["toolCallId"] as? String, !call.isEmpty,
      let runId = object["runId"] as? String, !runId.isEmpty,
      let status = object["status"] as? String, !status.isEmpty
    else { return nil }
    func date(_ key: String, in dict: [String: Any]) -> Date? {
      guard let seconds = (dict[key] as? NSNumber)?.doubleValue, seconds > 0 else { return nil }
      return Date(timeIntervalSince1970: seconds)
    }
    func text(_ key: String) -> String? {
      let value = (object[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
      return value.flatMap { $0.isEmpty ? nil : $0 }
    }
    let phases: [ChatWorkflowRun.Phase] = (object["phases"] as? [[String: Any]] ?? []).map { phase in
      let agents: [ChatWorkflowRun.Agent] = (phase["agents"] as? [[String: Any]] ?? []).map { agent in
        let activity = (agent["activity"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let state: ChatWorkflowRun.Agent.State =
          switch agent["state"] as? String {
          case "done": .done
          case "stopped": .stopped
          default: status == "running" ? .running : .stopped
          }
        return ChatWorkflowRun.Agent(
          label: agent["label"] as? String ?? "", state: state,
          startedAt: date("startedAt", in: agent), endedAt: date("endedAt", in: agent), activity: activity)
      }
      return ChatWorkflowRun.Phase(title: phase["title"] as? String ?? "", agents: agents)
    }
    return ChatWorkflowRun(
      toolCallId: call, runId: runId, title: text("title") ?? "Workflow", description: text("description"),
      status: status == "running" ? .running : status == "completed" ? .completed : .ended(status),
      startedAt: date("startedAt", in: object), endedAt: date("endedAt", in: object),
      lastActivityAt: date("lastActivityAt", in: object), summary: text("summary"),
      phases: phases)
  }
}

/// What the chat knows of its Workflow runs, and whether it is worth asking the host again.
struct ChatWorkflowTracker: Equatable, Sendable {
  static let toolName = "Workflow"
  static let pollInterval: Duration = .seconds(5)
  /// Answers unchanged this long slow the polling down; any change brings it back.
  static let slowAfter: TimeInterval = 120
  static let slowFactor = 6
  /// Answers that may lack a just-launched call before the host is taken not to know it.
  static let maxMisses = 6

  /// How a Workflow tool row reads once the host has spoken.
  enum RowStatus: Equatable, Sendable { case running, done, failed }

  private(set) var runs: [ChatWorkflowRun] = []
  /// False once the host answered like one without the command: nothing is asked again.
  private(set) var supported = true
  private var misses: [String: Int] = [:]
  private var changedAt: Date?

  var running: [ChatWorkflowRun] { runs.filter(\.isRunning) }

  func run(forCall id: String) -> ChatWorkflowRun? { runs.first { $0.toolCallId == id } }

  /// The wait before the next ask: `base`, or six times that once answers have not changed for two minutes.
  func interval(base: Duration, now: Date) -> Duration {
    guard let changedAt, now.timeIntervalSince(changedAt) >= Self.slowAfter else { return base }
    return base * Self.slowFactor
  }

  /// `output` is nil when the host could not be asked; nothing changes then, and neither does it
  /// for output that is not a listing, except that the host's unknown-command text ends the asking.
  mutating func apply(output: String?, calls: [ChatToolCall], now: Date = .now) {
    guard let output else { return }
    let listing = ChatWorkflowListing.parse(output)
    if listing.unsupported {
      supported = false
      runs = []
      return
    }
    guard !listing.failed else { return }
    if listing.runs != runs || changedAt == nil { changedAt = now }
    runs = listing.runs
    for call in calls {
      misses[call.id] = run(forCall: call.id) == nil ? (misses[call.id] ?? 0) + 1 : 0
    }
  }

  /// True while a Workflow call is not known to be over: its run is running, or the host has not
  /// listed it yet (a launch can show here before the host's file does).
  func needsPolling(calls: [ChatToolCall]) -> Bool {
    guard supported else { return false }
    return calls.contains { call in
      guard call.isWorkflow == true, call.status != .failed else { return false }
      if let run = run(forCall: call.id) { return run.isRunning }
      return (misses[call.id] ?? 0) < Self.maxMisses
    }
  }

  func rowStatus(forCall id: String) -> RowStatus? {
    guard supported, let run = run(forCall: id) else { return nil }
    switch run.status {
    case .running: return .running
    case .completed: return .done
    case .ended: return .failed
    }
  }

  /// The items as the transcript shows them: a Workflow row is running until the host reports its
  /// end, then done or failed. A call the host does not list keeps what ACP said.
  func display(_ items: [ChatItem]) -> [ChatItem] {
    guard supported, !runs.isEmpty else { return items }
    return items.map { item in
      guard case var .tool(call) = item.kind, call.isWorkflow == true, let status = rowStatus(forCall: call.id) else {
        return item
      }
      switch status {
      case .running: call.status = .inProgress
      case .done: call.status = .completed
      case .failed: call.status = .failed
      }
      var changed = item
      changed.kind = .tool(call)
      return changed
    }
  }
}
