import Foundation

/// One slash-command offered in the agent-chat palette. Duplicated from the
/// desktop `agentCommands.ts` table on purpose — the palette UI is per-platform,
/// so only this small table is kept in sync, not shared through the core.
public struct AgentCommand: Equatable, Identifiable, Sendable {
  public let id: String
  public let trigger: String
  public let kind: Kind
  public let args: String?
  public let glyph: String
  public let desc: String
  public enum Kind: Sendable { case local, agent }

  public init(
    id: String, trigger: String, kind: Kind, args: String?, glyph: String, desc: String
  ) {
    self.id = id
    self.trigger = trigger
    self.kind = kind
    self.args = args
    self.glyph = glyph
    self.desc = desc
  }
}

/// The result of interpreting a composer draft that starts with `/`.
public enum AgentDispatch: Equatable, Sendable {
  case local(id: String, args: String)
  case agentText(String)
  case none
}

/// Which sub-picker is open over the composer.
public enum AgentPickerKind: Sendable, Equatable, Identifiable {
  case model, resume
  public var id: Int { self == .model ? 0 : 1 }
}

/// One past Claude Code session offered in the /resume picker. Mirror of the
/// server's `ClaudeSessionMeta`; decoded from the `agent.sessions` frame.
public struct ClaudeSessionMeta: Codable, Sendable, Identifiable, Equatable {
  public let id: String
  public let label: String
  public let mtimeMs: Double
  public let msgCount: Int
  public let cwd: String
}

public let agentCommands: [AgentCommand] = [
  .init(id: "clear", trigger: "/clear", kind: .local, args: nil, glyph: "⌫", desc: "Start a fresh conversation"),
  .init(id: "copy", trigger: "/copy", kind: .local, args: "[last|all]", glyph: "⧉", desc: "Copy the transcript"),
  .init(id: "retry", trigger: "/retry", kind: .local, args: nil, glyph: "↻", desc: "Resend the last prompt"),
  .init(id: "model", trigger: "/model", kind: .local, args: nil, glyph: "◎", desc: "Switch the model"),
  .init(id: "resume", trigger: "/resume", kind: .local, args: nil, glyph: "⟲", desc: "Reopen a past session"),
  .init(id: "compact", trigger: "/compact", kind: .agent, args: nil, glyph: "⊘", desc: "Summarize context"),
  .init(id: "init", trigger: "/init", kind: .agent, args: nil, glyph: "✦", desc: "Generate a CLAUDE.md"),
  .init(id: "review", trigger: "/review", kind: .agent, args: "[target]", glyph: "▤", desc: "Review the current diff"),
  .init(id: "commit", trigger: "/commit", kind: .agent, args: "[msg]", glyph: "✎", desc: "Stage and commit"),
]

/// The `/model` aliases. Static — the CLI exposes no list and an alias tracks the
/// latest model of its tier, so a release needs no update here.
public let agentModelAliases: [(name: String, desc: String)] = [
  ("sonnet", "Balanced — the default for coding turns"),
  ("opus", "Deepest reasoning, slower"),
  ("haiku", "Fast and cheap for light edits"),
  ("opusplan", "Opus to plan, Sonnet to execute"),
  ("default", "Whatever your subscription picks"),
]

/// Palette matches — active only while the draft is a single `/word` with no space.
public func matchCommands(_ draft: String) -> [AgentCommand] {
  guard draft.hasPrefix("/"), !draft.contains(" ") else { return [] }
  let q = draft.dropFirst().lowercased()
  if q.isEmpty { return agentCommands }
  return agentCommands.filter { $0.id.contains(q) }
}

public func dispatchDraft(_ draft: String) -> AgentDispatch {
  guard draft.hasPrefix("/") else { return .none }
  let parts = draft.dropFirst().split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
  let head = String(parts.first ?? "")
  let args = parts.count > 1 ? String(parts[1]) : ""
  if let cmd = agentCommands.first(where: { $0.id == head }), cmd.kind == .local {
    return .local(id: cmd.id, args: args)
  }
  return .agentText(draft)
}
