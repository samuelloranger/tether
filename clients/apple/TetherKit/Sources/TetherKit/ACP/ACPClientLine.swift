import Foundation

/// A line another client sent, as a holder that takes several clients echoes it into the log
/// (`_tether/client`). Its prompts, stops and answers become the events this client's own would,
/// so every attached device shows the same conversation.
enum ACPClientLine: Equatable, Sendable {
  static let echoMethod = "_tether/client"

  case prompt(id: ACPID?, text: String, imageCount: Int, sessionId: String?)
  /// Continuing an earlier conversation: names the session before any prompt does.
  case load(sessionId: String?)
  case cancel
  case permissionAnswer(id: ACPID, optionId: String)
  case questionAnswer(id: ACPID, action: ChatQuestionAction, content: [String: ChatQuestionValue])
  /// The handshake, a mode change whose result the agent reports itself: nothing to show.
  case other

  func events(atOffset offset: Int) -> [ChatEvent] {
    switch self {
    case let .prompt(id, text, imageCount, _):
      return [.userPrompt(text: text, imageCount: imageCount, atOffset: offset, requestId: id)]
    case .cancel:
      return [.cancelRequested]
    case let .permissionAnswer(id, optionId):
      return [.permissionAnswered(requestId: id, optionId: optionId)]
    case let .questionAnswer(id, action, content):
      return [.questionAnswered(requestId: id, action: action, content: content)]
    case .load, .other:
      return []
    }
  }
}
