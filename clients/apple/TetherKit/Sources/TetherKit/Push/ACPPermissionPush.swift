import Foundation
import UserNotifications

/// A held ACP permission request, as its push carries it. The NSE copies these fields onto
/// the notification's userInfo so a button tap can answer without the payload.
public struct ACPPermissionPush: Equatable, Sendable {
  public static let category = "tether.acp.permission"
  public static let categoryPrefix = "tether.acp.permission."
  public static let doneCategory = "tether.acp.done"
  static let maxOptions = 4

  public var chat: ChatDeepLink
  /// The holder session name `tether-notify acp answer` takes.
  public var acp: String
  /// The raw JSON-RPC id as JSON text.
  public var requestId: String
  public var options: [Option]

  public struct Option: Equatable, Sendable {
    public var label: String
    public var id: String
    public var kind: String

    public var isReject: Bool { kind.hasPrefix("reject") }
    /// An answer to a question (`elicitation: true` in the payload), not a permission.
    public var isChoice: Bool { kind == "choice" }
  }

  /// nil unless the userInfo holds a link, a usable holder name, a request id and at least
  /// two options with matching ids.
  public init?(userInfo: [AnyHashable: Any]) {
    guard let link = NotificationTapRouter.link(from: userInfo), let chat = ChatDeepLink.parse(link),
          let acp = userInfo["acpName"] as? String, !acp.isEmpty, !acp.hasPrefix("-"),
          let requestId = userInfo["acpRequestId"] as? String, !requestId.isEmpty,
          let labels = userInfo["acpOptions"] as? [String],
          let ids = userInfo["acpOptionIds"] as? [String],
          (2...Self.maxOptions).contains(labels.count), ids.count == labels.count,
          !ids.contains(where: \.isEmpty)
    else { return nil }
    let kinds = (userInfo["acpOptionKinds"] as? [String]) ?? []
    self.chat = chat
    self.acp = acp
    self.requestId = requestId
    options = labels.indices.map {
      Option(label: labels[$0], id: ids[$0], kind: $0 < kinds.count ? kinds[$0] : "")
    }
  }

  /// A tapped option button's action identifier (`tether.action.option.N`) is that option's
  /// 1-based number.
  public func option(forAction actionIdentifier: String) -> Option? {
    let prefix = NotificationActions.optionActionPrefix
    guard actionIdentifier.hasPrefix(prefix), let number = Int(actionIdentifier.dropFirst(prefix.count)),
          options.indices.contains(number - 1)
    else { return nil }
    return options[number - 1]
  }

  /// One button per option, destructive for a reject. Mirrored by the NSE, which doesn't link TetherKit.
  public static func notificationCategory(
    version: String, labels: [String], kinds: [String]
  ) -> UNNotificationCategory {
    let actions = labels.prefix(maxOptions).enumerated().map { index, label in
      var options: UNNotificationActionOptions = [.authenticationRequired]
      if index < kinds.count, kinds[index].hasPrefix("reject") { options.insert(.destructive) }
      return UNNotificationAction(identifier: NotificationActions.optionAction(index + 1), title: label, options: options)
    }
    return UNNotificationCategory(identifier: categoryPrefix + version, actions: actions, intentIdentifiers: [])
  }
}

/// One button tap, ready to send.
public struct ACPAnswerRequest: Equatable, Sendable {
  public var chat: ChatDeepLink
  public var acp: String
  public var requestId: String
  public var optionId: String
  public var optionLabel: String
  public var isChoice = false
}

enum ACPAnswerCommand {
  /// Every value is quoted, so nothing the agent or a chat name holds is parsed by a shell.
  static func command(notify: String, request: ACPAnswerRequest) -> String {
    [
      notify, "acp", "answer", shellQuote(request.acp),
      "--request", shellQuote(request.requestId),
      "--option", shellQuote(request.optionId),
    ].joined(separator: " ")
  }

  static func answersCommand(notify: String, acp: String) -> String {
    "\(notify) acp answers \(shellQuote(acp))"
  }

  /// `tether-notify acp answers` output: `{requestId: optionId | "cancelled"}`. Anything that
  /// isn't that object gives nothing.
  static func parseAnswers(_ output: String) -> [ACPID: String] {
    guard let line = output.split(separator: "\n").last(where: { $0.hasPrefix("{") }),
          let map = try? JSONDecoder().decode([String: String].self, from: Data(line.utf8))
    else { return [:] }
    var answers: [ACPID: String] = [:]
    for (key, value) in map where !value.isEmpty {
      answers[id(fromJSONText: key)] = value
    }
    return answers
  }

  /// The inverse of how the holder writes a JSON-RPC id as text: `7`, or `"abc"`.
  static func id(fromJSONText text: String) -> ACPID {
    if let number = Int(text) { return .int(number) }
    if let string = try? JSONDecoder().decode(String.self, from: Data(text.utf8)) { return .string(string) }
    return .string(text)
  }
}
