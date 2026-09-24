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

public struct NotificationActionRequest: Equatable, Sendable {
  public var link: SessionDeepLink
  public var input: NotificationInput
}

/// Approve / Deny / Reply on agent pushes. `tether-notify` stamps the category inside the
/// encrypted payload; the NSE copies it onto the notification.
public enum NotificationActions {
  public static let waitingCategory = "tether.agent.waiting"
  public static let doneCategory = "tether.agent.done"
  public static let categoryIdentifiers: Set<String> = [waitingCategory, doneCategory]

  static let approveAction = "tether.action.approve"
  static let denyAction = "tether.action.deny"
  static let replyAction = "tether.action.reply"

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

  public static func request(
    actionIdentifier: String, text: String?, userInfo: [AnyHashable: Any]
  ) -> NotificationActionRequest? {
    guard let input = input(actionIdentifier: actionIdentifier, text: text),
          let link = NotificationTapRouter.link(from: userInfo),
          let deep = DeepLinkCoordinator.parse(link)
    else { return nil }
    return NotificationActionRequest(link: deep, input: input)
  }

  static func command(zmx: String, session: String, input: NotificationInput) -> String {
    let send = "\(zmx) send \(shellQuote(session))"
    let returnKey = "\"$(printf '\\015')\""
    switch input {
    case let .keys(keys):
      return "\(send) \"$(printf '\(octalEscaped(keys))')\""
    case let .line(text):
      return "\(send) \(shellQuote(text)) && sleep 0.3 && \(send) \(returnKey)"
    }
  }

  private static func octalEscaped(_ keys: String) -> String {
    keys.utf8.map { byte in
      let digits = String(byte, radix: 8)
      return "\\" + String(repeating: "0", count: 3 - digits.count) + digits
    }.joined()
  }
}

/// Runs an action off a push: finds the saved machine the push's link names, then types
/// into the session with a one-off `zmx send` over its own SSH connection.
@MainActor
public final class NotificationActionRunner {
  typealias Exec = @Sendable (SSHConnectionConfig, HostKeyStore, String) async throws -> String

  private static let doneMarker = "__tether_sent=0"

  private let model: HomeModel
  private let exec: Exec

  init(model: HomeModel, exec: @escaping Exec) {
    self.model = model
    self.exec = exec
  }

  public static func live() -> NotificationActionRunner {
    NotificationActionRunner(model: .live()) { config, store, command in
      try await withThrowingTaskGroup(of: String?.self) { group in
        group.addTask {
          let output = LockedBox("")
          // Cancelling the stream shuts the socket, so a stalled host frees us too.
          try await SSHConnector.execStream(config: config, store: store, command: command) { chunk in
            output.value += chunk
            return true
          }
          return output.value
        }
        group.addTask {
          try await Task.sleep(nanoseconds: 20_000_000_000)
          return nil
        }
        defer { group.cancelAll() }
        guard let first = try await group.next(), let output = first else {
          throw SSHConnectError.commandTimedOut
        }
        return output
      }
    }
  }

  /// Returns why the action failed, or nil once zmx accepted the input.
  func run(_ request: NotificationActionRequest) async -> String? {
    model.reload()
    let route = request.link.route(profiles: model.profiles, currentProfileID: nil, currentHostLabels: [])
    guard case let .open(profileID, session) = route,
          let profile = model.profiles.first(where: { $0.id == profileID })
    else { return "No saved machine matches “\(request.link.identityName)”." }
    guard let config = model.connectionConfig(for: profile) else {
      return SSHConnectError.missingCredential(name: profile.name).errorDescription
    }
    let command = NotificationActions.command(zmx: SSHTerminalController.zmx, session: session, input: request.input)
      + "; echo __tether_sent=$?"
    do {
      let output = try await exec(config, model.hostKeyStore, command)
      return output.contains(Self.doneMarker) ? nil : "zmx could not reach session “\(session)” on \(profile.name)."
    } catch {
      return error.localizedDescription
    }
  }

  /// Runs the action and, if it fails, says so in a local notification — the user acted
  /// from the lock screen and has no other place to see the error.
  public func perform(_ request: NotificationActionRequest) async {
    guard let failure = await run(request) else { return }
    let content = UNMutableNotificationContent()
    content.title = "Couldn’t send to \(request.link.sessionId)"
    content.body = failure
    var link = URLComponents()
    link.scheme = "tether"
    link.host = "session"
    link.path = "/\(request.link.sessionId)"
    link.queryItems = [URLQueryItem(name: "host", value: request.link.identityName)]
    content.userInfo["link"] = link.url?.absoluteString
    let notice = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    try? await UNUserNotificationCenter.current().add(notice)
  }
}
