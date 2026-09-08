import SwiftUI

/// One tool invocation inside an assistant turn — the characteristic unit of an
/// agent transcript. `summary` is the one-line human form (the command, the
/// path); `inputJSON` is the full arguments; `diff` is a unified patch when the
/// tool edits a file, rendered inline.
public struct AgentToolCall: Identifiable, Equatable, Sendable {
  public let id: UUID
  public let name: String
  public var summary: String
  public var inputJSON: String
  public var result: String?
  public var isError: Bool
  public var diff: String?

  public init(
    id: UUID = UUID(),
    name: String,
    summary: String,
    inputJSON: String,
    result: String? = nil,
    isError: Bool = false,
    diff: String? = nil
  ) {
    self.id = id
    self.name = name
    self.summary = summary
    self.inputJSON = inputJSON
    self.result = result
    self.isError = isError
    self.diff = diff
  }
}

public struct AgentMessage: Identifiable, Equatable, Sendable {
  public enum Role: Sendable { case user, assistant, error }
  public let id: UUID
  public var role: Role
  public var text: String
  public var tools: [AgentToolCall]
  public var isStreaming: Bool

  public init(
    id: UUID = UUID(),
    role: Role,
    text: String = "",
    tools: [AgentToolCall] = [],
    isStreaming: Bool = false
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.tools = tools
    self.isStreaming = isStreaming
  }
}

public enum AgentTurnState: Sendable, Equatable { case idle, thinking, streaming }

/// Tool identity drives the console-card colour + glyph. Bash is the loud one
/// (it runs commands), edits are accent, reads are quiet.
public enum AgentToolStyle {
  public static func accent(for name: String) -> Color {
    switch name.lowercased() {
    case "bash", "shell": return TetherColors.success
    case "edit", "write", "multiedit", "notebookedit": return TetherColors.accent
    case "read", "glob", "grep", "ls": return TetherColors.textSecondary
    case "webfetch", "websearch": return TetherColors.info
    default: return TetherColors.textSecondary
    }
  }

  public static func glyph(for name: String) -> String {
    switch name.lowercased() {
    case "bash", "shell": return "terminal"
    case "edit", "write", "multiedit", "notebookedit": return "pencil.and.outline"
    case "read": return "doc.text"
    case "glob", "grep", "ls": return "magnifyingglass"
    case "webfetch", "websearch": return "globe"
    default: return "wrench.and.screwdriver"
    }
  }
}
