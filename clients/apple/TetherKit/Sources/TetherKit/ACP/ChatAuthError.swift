import Foundation

/// Tells "the agent has no login" from every other agent error. `-32000` is ACP's auth_required;
/// the wording covers adapters that report it as a plain error.
enum ChatAuthError {
  static let code = -32000

  private static let phrases = [
    "authenticat", "unauthorized", "not logged in", "login", "log in", "sign in", "signed in", "credential",
    "invalid api key", "oauth",
  ]

  static func matches(code: Int, message: String) -> Bool {
    if code == Self.code { return true }
    let lower = message.lowercased()
    return phrases.contains { lower.contains($0) }
  }

  static func matches(_ error: Error) -> Bool {
    guard case let .agent(code, message)? = error as? ACPClientError else { return false }
    return matches(code: code, message: message)
  }
}
