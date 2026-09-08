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

/// One ordered piece of an assistant turn — text and tool calls interleaved in
/// the order the server emitted them, so the transcript reads paragraph, its
/// tool, next paragraph, its tool… rather than all text then all tools.
public enum AgentBlock: Identifiable, Equatable, Sendable {
  case text(id: UUID, String)
  case tool(AgentToolCall)

  public var id: UUID {
    switch self {
    case let .text(id, _): id
    case let .tool(call): call.id
    }
  }
}

/// Cost + token usage for one finished assistant turn, shown as a small footer.
public struct AgentUsage: Equatable, Sendable {
  public var cost: Double
  public var inputTokens: Int
  public var outputTokens: Int

  public init(cost: Double, inputTokens: Int, outputTokens: Int) {
    self.cost = cost
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
  }

  /// Nothing worth showing — a subscription turn that reported neither cost nor
  /// tokens. The footer is hidden in that case.
  public var isEmpty: Bool { cost == 0 && inputTokens == 0 && outputTokens == 0 }
}

public struct AgentMessage: Identifiable, Equatable, Sendable {
  public enum Role: Sendable { case user, assistant, error }
  public let id: UUID
  public var role: Role
  public var blocks: [AgentBlock]
  public var isStreaming: Bool
  /// Set when the assistant turn finishes (`agent.done`); drives the cost/token footer.
  public var usage: AgentUsage?

  public init(
    id: UUID = UUID(),
    role: Role,
    text: String = "",
    blocks: [AgentBlock]? = nil,
    isStreaming: Bool = false,
    usage: AgentUsage? = nil
  ) {
    self.id = id
    self.role = role
    self.blocks = blocks ?? (text.isEmpty ? [] : [.text(id: UUID(), text)])
    self.isStreaming = isStreaming
    self.usage = usage
  }

  /// Concatenation of the `.text` blocks — the whole message for user/error
  /// rows (which are always a single text block) and a plain-text fallback
  /// for anything that just wants the words.
  public var plainText: String {
    blocks.reduce(into: "") { acc, block in
      if case let .text(_, s) = block { acc += s }
    }
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
