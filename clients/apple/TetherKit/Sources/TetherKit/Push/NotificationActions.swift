import Foundation
import UserNotifications

/// What a notification action types into the session its push points at.
public enum NotificationInput: Equatable, Sendable {
  /// Raw keys in one write.
  case keys(String)
  /// Text, then Return in a separate write: a TUI that reads both at once can take them
  /// as a paste and not submit.
  case line(String)
}

/// The agent state a push was about. The host only types the input while the agent is
/// still in it, so an old Approve cannot answer a newer prompt.
public struct AgentExpectation: Equatable, Sendable {
  public var state: String
  public var since: Int64
}

public struct NotificationActionRequest: Equatable, Sendable {
  public var link: SessionDeepLink
  public var expect: AgentExpectation
  public var input: NotificationInput
}

/// A tapped action: something to send, or a push that can't be answered from here.
public enum NotificationActionAttempt: Equatable, Sendable {
  case answer(NotificationActionRequest)
  case unanswerable(link: String?)
}

/// Approve / Deny / Reply on agent pushes. `tether-notify` stamps the category and the
/// agent state inside the encrypted payload; the NSE copies them onto the notification.
public enum NotificationActions {
  public static let waitingCategory = "tether.agent.waiting"
  public static let doneCategory = "tether.agent.done"
  public static let categoryIdentifiers: Set<String> = [waitingCategory, doneCategory]

  static let approveAction = "tether.action.approve"
  static let denyAction = "tether.action.deny"
  static let replyAction = "tether.action.reply"
  static let actionIdentifiers: Set<String> = [approveAction, denyAction, replyAction]

  /// Every action requires an unlocked phone: each one types into a live shell.
  public static func categories() -> Set<UNNotificationCategory> {
    let approve = UNNotificationAction(
      identifier: approveAction, title: "Approve", options: [.authenticationRequired],
      icon: UNNotificationActionIcon(systemImageName: "checkmark")
    )
    let deny = UNNotificationAction(
      identifier: denyAction, title: "Deny", options: [.authenticationRequired, .destructive],
      icon: UNNotificationActionIcon(systemImageName: "xmark")
    )
    let reply = UNTextInputNotificationAction(
      identifier: replyAction, title: "Reply", options: [.authenticationRequired],
      icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
      textInputButtonTitle: "Send", textInputPlaceholder: "Message the agent"
    )
    return [
      UNNotificationCategory(identifier: waitingCategory, actions: [approve, deny, reply], intentIdentifiers: []),
      UNNotificationCategory(identifier: doneCategory, actions: [reply], intentIdentifiers: []),
    ]
  }

  /// Approve is Return — the highlighted "Yes" in Claude Code's and Codex's approval
  /// prompts. Deny is Esc, which both treat as "no".
  public static func input(actionIdentifier: String, text: String?) -> NotificationInput? {
    switch actionIdentifier {
    case approveAction: return .keys("\r")
    case denyAction: return .keys("\u{1b}")
    case replyAction:
      // A newline mid-reply would submit early.
      let line = (text ?? "").components(separatedBy: .newlines).joined(separator: " ")
        .trimmingCharacters(in: .whitespaces)
      return line.isEmpty ? nil : .line(line)
    default: return nil
    }
  }

  /// `nil` for anything that isn't one of our actions.
  public static func attempt(
    actionIdentifier: String, text: String?, userInfo: [AnyHashable: Any]
  ) -> NotificationActionAttempt? {
    guard actionIdentifiers.contains(actionIdentifier) else { return nil }
    let link = NotificationTapRouter.link(from: userInfo)
    guard let input = input(actionIdentifier: actionIdentifier, text: text) else {
      return .unanswerable(link: link)
    }
    guard let link, let deep = DeepLinkCoordinator.parse(link),
          !deep.sessionId.hasPrefix("-"),
          let expect = expectation(from: userInfo)
    else { return .unanswerable(link: link) }
    return .answer(NotificationActionRequest(link: deep, expect: expect, input: input))
  }

  static func expectation(from userInfo: [AnyHashable: Any]) -> AgentExpectation? {
    guard let state = userInfo["agentState"] as? String, !state.isEmpty else { return nil }
    let since: Int64?
    switch userInfo["agentSince"] {
    case let number as NSNumber: since = number.int64Value
    case let text as String: since = Int64(text)
    default: since = nil
    }
    guard let since, since > 0 else { return nil }
    return AgentExpectation(state: state, since: since)
  }

  /// `tether-notify answer` checks the agent state and runs `zmx send` itself, passing the
  /// input as an argument: nothing the user typed is ever parsed by a shell.
  static func command(notify: String, request: NotificationActionRequest) -> String {
    let bytes: String
    let submit: Bool
    switch request.input {
    case let .keys(keys): bytes = keys; submit = false
    case let .line(text): bytes = text; submit = true
    }
    var parts = [
      notify, "answer",
      "--session", shellQuote(request.link.sessionId),
      "--state", shellQuote(request.expect.state),
      "--since", String(request.expect.since),
      "--input", shellQuote(Data(bytes.utf8).base64EncodedString()),
    ]
    if submit { parts.append("--submit") }
    return parts.joined(separator: " ")
  }
}

/// Runs an action off a push: finds the one saved machine the push's link names, then asks
/// its `tether-notify` to type the input over a one-off SSH connection.
@MainActor
public final class NotificationActionRunner {
  typealias Exec = @Sendable (SSHConnectionConfig, HostKeyStore, String) async throws -> String

  static let notify = "~/.local/bin/tether-notify"
  private static let exitMarker = "__tether_sent="

  private let model: HomeModel
  private let timeout: Duration
  private let exec: Exec

  init(model: HomeModel, timeout: Duration = .seconds(20), exec: @escaping Exec) {
    self.model = model
    self.timeout = timeout
    self.exec = exec
  }

  public static func live() -> NotificationActionRunner {
    NotificationActionRunner(model: .live()) { config, store, command in
      let output = LockedBox("")
      // Cancelling the stream shuts the socket once one is open.
      try await SSHConnector.execStream(config: config, store: store, command: command) { chunk in
        output.value += chunk
        return true
      }
      return output.value
    }
  }

  /// Returns why the action failed, or nil once the host accepted the input.
  func run(_ request: NotificationActionRequest) async -> String? {
    model.reload()
    let label = request.link.identityName
    let matches = Self.candidates(for: label, in: model.profiles)
    guard !matches.isEmpty else { return "No saved machine matches “\(label)”." }
    // Two machines answering to one label could send the keystroke to the wrong host.
    guard matches.count == 1, let profile = matches.first else {
      return "“\(label)” matches \(matches.count) saved machines; open the session to answer."
    }
    guard let config = model.connectionConfig(for: profile) else {
      return SSHConnectError.missingCredential(name: profile.name).errorDescription
    }
    let command = NotificationActions.command(notify: Self.notify, request: request)
      + " 2>&1; echo \(Self.exitMarker)$?"
    let output: String
    do {
      output = try await withDeadline(timeout) { [exec, store = model.hostKeyStore] in
        try await exec(config, store, command)
      }
    } catch {
      return error.localizedDescription
    }
    return Self.failure(output: output, session: request.link.sessionId, machine: profile.name)
  }

  /// The profiles a label could mean, by the same rules a tapped link uses.
  static func candidates(for label: String, in profiles: [SSHHostProfile]) -> [SSHHostProfile] {
    let label = label.lowercased()
    return profiles.filter { profile in
      profile.name.lowercased() == label
        || profile.host.lowercased() == label
        || profile.host.lowercased().split(separator: ".").first.map(String.init) == label
    }
  }

  static func failure(output: String, session: String, machine: String) -> String? {
    guard let marker = output.range(of: exitMarker, options: .backwards) else {
      return "No answer from \(machine)."
    }
    let code = Int(output[marker.upperBound...].prefix { $0.isNumber }) ?? -1
    let detail = output[..<marker.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
    switch code {
    case 0: return nil
    case 3: return "The agent in “\(session)” has moved on; nothing was sent."
    // 127: not installed; 2: an older build without `answer` prints its usage.
    case 127, 2: return "Update tether-notify on \(machine) to answer notifications."
    default: return detail.isEmpty ? "tether-notify couldn’t answer on \(machine)." : detail
    }
  }

  /// Returns when the deadline passes even if the work doesn't stop: name resolution
  /// blocks its thread and can't be cancelled, and the notification's completion handler
  /// must not wait on it.
  private func withDeadline(
    _ deadline: Duration, _ work: @escaping @Sendable () async throws -> String
  ) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      let gate = ResumeOnce(continuation)
      let task = Task {
        do { gate.resume(.success(try await work())) }
        catch { gate.resume(.failure(error)) }
      }
      Task {
        try? await Task.sleep(for: deadline)
        gate.resume(.failure(SSHConnectError.commandTimedOut))
        task.cancel()
      }
    }
  }

  public func perform(_ attempt: NotificationActionAttempt) async {
    switch attempt {
    case let .answer(request):
      guard let failure = await run(request) else { return }
      await notifyFailure(failure, session: request.link.sessionId, link: Self.link(for: request.link))
    case let .unanswerable(link):
      await notifyFailure("This notification can’t be answered from here; open the session instead.",
                          session: nil, link: link)
    }
  }

  /// The user acted from the lock screen and has no other place to see the error.
  private func notifyFailure(_ message: String, session: String?, link: String?) async {
    let content = UNMutableNotificationContent()
    content.title = session.map { "Couldn’t send to \($0)" } ?? "Couldn’t send"
    content.body = message
    if let link { content.userInfo["link"] = link }
    let notice = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    try? await UNUserNotificationCenter.current().add(notice)
  }

  private static func link(for deep: SessionDeepLink) -> String? {
    var link = URLComponents()
    link.scheme = "tether"
    link.host = "session"
    link.path = "/\(deep.sessionId)"
    link.queryItems = [URLQueryItem(name: "host", value: deep.identityName)]
    return link.url?.absoluteString
  }
}

/// A continuation two racing tasks may both try to resume; only the first wins.
private final class ResumeOnce<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Error>?

  init(_ continuation: CheckedContinuation<Value, Error>) {
    self.continuation = continuation
  }

  func resume(_ result: Result<Value, Error>) {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(with: result)
  }
}
