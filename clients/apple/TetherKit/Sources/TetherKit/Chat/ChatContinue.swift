import Foundation

/// An earlier conversation the agent has stored for a folder, from `acp sessions`.
struct ACPSavedSession: Equatable, Identifiable, Sendable {
  var sessionId: String
  var title: String
  var updatedAt: Date?
  var cwd: String

  var id: String { sessionId }
  var displayTitle: String { title.isEmpty ? "Untitled conversation" : title }
}

/// `acp sessions`: one JSON object per conversation, newest first. Stray lines are what the host
/// printed on failure (its stderr is folded in), so with no conversation parsed they become the reason.
enum ACPSavedSessionListing {
  struct Result: Equatable {
    var sessions: [ACPSavedSession]
    var failure: String?
  }

  static func parse(_ output: String) -> Result {
    var sessions: [ACPSavedSession] = []
    var stray: [String] = []
    for raw in output.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty else { continue }
      guard let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
        let id = object["sessionId"] as? String, !id.isEmpty
      else {
        stray.append(line)
        continue
      }
      sessions.append(
        ACPSavedSession(
          sessionId: id, title: (object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
          updatedAt: (object["updatedAt"] as? String).flatMap(date), cwd: object["cwd"] as? String ?? ""))
    }
    guard sessions.isEmpty, let first = stray.first else { return Result(sessions: sessions, failure: nil) }
    return Result(sessions: [], failure: explain(first))
  }

  static func explain(_ line: String) -> String {
    let lower = line.lowercased()
    if lower.contains("unknown acp command") || lower.contains("not found") || lower.contains("usage") {
      return "This host's tether is too old to list earlier conversations. Update it."
    }
    let trimmed = line.replacingOccurrences(of: "tether: ", with: "")
    return trimmed.count > 160 ? String(trimmed.prefix(160)) + "…" : trimmed
  }

  static func date(_ text: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: text) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: text)
  }
}

enum ChatContinueFormat {
  /// Inside this window the conversation may still be open in a terminal on the host.
  static let recentWindow: TimeInterval = 10 * 60
  static let recentNote = "Updated minutes ago: it may still be open in a terminal"

  static func isRecent(_ updatedAt: Date?, now: Date) -> Bool {
    guard let updatedAt else { return false }
    let age = now.timeIntervalSince(updatedAt)
    return age < recentWindow
  }

  static func relative(_ updatedAt: Date?, now: Date) -> String {
    guard let updatedAt else { return "" }
    let seconds = max(0, Int(now.timeIntervalSince(updatedAt)))
    switch seconds {
    case ..<60: return "just now"
    case ..<3600: return "\(seconds / 60) min ago"
    case ..<86400: return "\(seconds / 3600) h ago"
    case ..<(86400 * 14): return "\(seconds / 86400) d ago"
    default: return updatedAt.formatted(.dateTime.month(.abbreviated).day())
    }
  }
}

struct ChatDeadlineExceeded: Error, Equatable {}

enum ChatContinueLoader {
  enum Result: Equatable {
    case loaded([ACPSavedSession])
    case failed(String)
  }

  static let limit = 20
  static let deadline: TimeInterval = 20

  /// Resolves `~`, lists the folder's conversations and gives up after `deadline`. Never throws:
  /// the sheet shows the reason with a Retry.
  static func load(
    folderText: String, agent: ChatAgentProfile = ChatAgents.claude,
    deadline: TimeInterval = ChatContinueLoader.deadline,
    exec: @escaping @Sendable (String) async throws -> String
  ) async -> Result {
    do {
      return try await withDeadline(deadline) { () -> Result in
        var home = ""
        if ACPCwd.needsHome(folderText) {
          guard let found = try? await exec(ACPHostCommand.home), found.hasPrefix("/") else {
            return .failed("Couldn't read the host's home folder.")
          }
          home = found.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let cwd = ACPCwd.expand(folderText, home: home)
        let output = try await exec(ACPHostCommand.sessions(cwd: cwd, limit: limit, agent: agent))
        let listing = ACPSavedSessionListing.parse(output)
        if let failure = listing.failure { return .failed(failure) }
        return .loaded(listing.sessions)
      }
    } catch is ChatDeadlineExceeded {
      return .failed("The host took too long to answer.")
    } catch {
      return .failed(ACPClientError.hostFailureText(error))
    }
  }

  /// Unstructured on purpose: a command that ignores cancellation (the control connection's exec
  /// does) must not hold the caller past the deadline, so the first finisher resumes and the rest is dropped.
  static func withDeadline<T: Sendable>(
    _ seconds: TimeInterval, _ operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
      let gate = LockedBox(false)
      @Sendable func finish(_ result: Swift.Result<T, Error>) {
        let first = gate.update { done -> Bool in
          defer { done = true }
          return !done
        }
        if first { continuation.resume(with: result) }
      }
      let work = Task {
        do { finish(.success(try await operation())) } catch { finish(.failure(error)) }
      }
      Task {
        try? await Task.sleep(for: .seconds(seconds))
        finish(.failure(ChatDeadlineExceeded()))
        work.cancel()
      }
    }
  }
}

extension ChatRoute {
  /// A chat that continues `session`: the same host checks as a fresh chat, then the folder it was listed under.
  static func startContinuing(
    session: ACPSavedSession, cwdText: String, host: String, agent: ChatAgentProfile = ChatAgents.claude,
    picks: [String: String]? = nil, changed: Set<String> = [], exec: (String) async throws -> String
  ) async -> ChatStart {
    switch await start(cwdText: cwdText, host: host, agent: agent, picks: picks, changed: changed, exec: exec) {
    case var .ready(route):
      route.loadSessionId = session.sessionId
      return .ready(route)
    case let failed: return failed
    }
  }
}
