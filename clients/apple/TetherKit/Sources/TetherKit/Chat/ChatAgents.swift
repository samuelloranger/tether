import Foundation

/// An agent a chat can run: how the host spawns it, how it is shown, and which of its options follow the user.
struct ChatAgentProfile: Equatable, Identifiable, Sendable {
  let key: String
  let label: String
  let spawn: String
  /// Appears in the holder's spawn command whatever flags or version follow it.
  let marker: String
  /// The option ids whose confirmed changes are stored as this agent's defaults.
  let rememberedIds: [String]
  let iconAsset: String
  /// A single-colour mark takes the text colour; Claude's keeps its own.
  let tintsIcon: Bool
  /// What the host's user runs to sign in; shown in the signed-out row.
  let signInCommand: String

  var id: String { key }

  func remembers(_ optionId: String) -> Bool { rememberedIds.contains(optionId) }
  var usesClaudeVerbs: Bool { key == ChatAgents.claude.key }
}

enum ChatAgents {
  static let claude = ChatAgentProfile(
    key: "claude", label: "Claude", spawn: "npx -y @agentclientprotocol/claude-agent-acp@0.95.0",
    marker: "claude-agent-acp", rememberedIds: ["model", "effort", "mode"], iconAsset: "agent-claude",
    tintsIcon: false, signInCommand: "claude")
  static let codex = ChatAgentProfile(
    key: "codex", label: "Codex", spawn: "npx -y @agentclientprotocol/codex-acp@2.3.0", marker: "codex-acp",
    rememberedIds: ["model", "reasoning_effort", "mode"], iconAsset: "agent-codex", tintsIcon: true,
    signInCommand: "codex login")
  static let opencode = ChatAgentProfile(
    key: "opencode", label: "opencode", spawn: "PATH=\"$HOME/.opencode/bin:$PATH\" opencode acp", marker: "opencode acp",
    rememberedIds: ["model", "effort", "mode"], iconAsset: "agent-opencode", tintsIcon: true,
    signInCommand: "opencode auth login")

  static let all = [claude, codex, opencode]

  static func profile(forKey key: String?) -> ChatAgentProfile? {
    guard let key else { return nil }
    return all.first { $0.key == key }
  }

  /// An exact spawn command first, then the marker (or the bare agent name, which older listings and
  /// fixtures carry); nil for an agent this app does not know.
  static func profile(forSpawn spawn: String) -> ChatAgentProfile? {
    let command = spawn.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !command.isEmpty else { return nil }
    return all.first { $0.spawn == command } ?? all.first { command.contains($0.marker) }
      ?? all.first { $0.key == command.lowercased() }
  }

  /// What a chat runs: the record this device kept, else the host's spawn command, else Claude
  /// (an old chat, or a host that does not report it). A spawn command nobody here knows is nil.
  static func resolve(localKey: String?, statusSpawn: String?) -> ChatAgentProfile? {
    if let local = profile(forKey: localKey) { return local }
    let spawn = statusSpawn?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if spawn.isEmpty { return claude }
    return profile(forSpawn: spawn)
  }

  /// "Codex", or the generic "Agent" for one this app does not know.
  static func label(of profile: ChatAgentProfile?) -> String { profile?.label ?? "Agent" }
}

/// The agent picked last on this device, which a new chat starts with.
struct ChatLastAgentStore {
  private static let key = "tether.acp.lastAgent"
  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  var agent: ChatAgentProfile {
    ChatAgents.profile(forKey: defaults.string(forKey: Self.key)) ?? ChatAgents.claude
  }

  func set(_ profile: ChatAgentProfile) { defaults.set(profile.key, forKey: Self.key) }
}

/// The options of an agent's last session on a host, kept on this device so the New chat sheet can
/// offer the same choices before any session exists.
final class ChatOptionsCache: @unchecked Sendable {
  private let defaults: UserDefaults
  private let scope: String

  init(scope: String, defaults: UserDefaults = .standard) {
    self.scope = scope
    self.defaults = defaults
  }

  convenience init(config: SSHConnectionConfig) { self.init(scope: ChatTitleStore.scope(for: config)) }

  private func key(_ agent: String) -> String { "tether.acp.optionChoices.\(scope).\(agent)" }

  func options(agent: String) -> [ACPConfigOption] {
    defaults.data(forKey: key(agent)).flatMap { try? JSONDecoder().decode([ACPConfigOption].self, from: $0) } ?? []
  }

  func clear(agent: String) { defaults.removeObject(forKey: key(agent)) }

  /// Keeps only the options the agent's profile remembers; an empty list leaves what is stored.
  func save(_ options: [ACPConfigOption], agent: ChatAgentProfile) {
    let kept = options.filter { agent.remembers($0.id) && !$0.choices.isEmpty }
    guard !kept.isEmpty, kept != self.options(agent: agent.key) else { return }
    defaults.set(try? JSONEncoder().encode(kept), forKey: key(agent.key))
  }
}

/// What the New chat sheet's Options row shows and what it hands the new chat.
enum ChatNewOptions {
  struct Row: Equatable, Identifiable {
    var id: String
    var name: String
    var choices: [ACPConfigChoice]
    var selected: String
    /// Differs from what the sheet opened with, so the row gets its accent edge.
    var changed: Bool
    var selectedName: String { choices.first { $0.value == selected }?.name ?? selected }
  }

  /// One row per remembered option the cache knows, in the profile's order. A value comes from the
  /// user's change, else the stored default, else the agent's current value; `reset` ignores the stored ones.
  static func rows(
    agent: ChatAgentProfile, stored: [String: String], cached: [ACPConfigOption], changes: [String: String] = [:],
    reset: Bool = false
  ) -> [Row] {
    let base = reset ? [:] : stored
    return agent.rememberedIds.compactMap { id in
      guard let option = cached.first(where: { $0.id == id }), !option.choices.isEmpty else { return nil }
      func valid(_ value: String?) -> String? {
        value.flatMap { value in option.choices.contains { $0.value == value } ? value : nil }
      }
      let opened = valid(base[id]) ?? option.currentValue
      let picked = valid(changes[id])
      return Row(
        id: id, name: option.name, choices: option.choices, selected: picked ?? opened,
        changed: picked != nil && picked != opened)
    }
  }

  /// "Opus · High · Auto", or "<Agent>'s defaults" when there is nothing cached or the user reset.
  static func summary(rows: [Row], agent: ChatAgentProfile, reset: Bool) -> String {
    guard !rows.isEmpty, !reset else { return "\(agent.label)'s defaults" }
    return rows.map(\.selectedName).joined(separator: " · ")
  }

  static func note(agent: ChatAgentProfile) -> String {
    "The choices appear after your first \(agent.label) chat on this host. Until then it starts on \(agent.label)'s own defaults."
  }

  /// nil leaves the new chat on the stored defaults, as without the sheet's row; a reset applies
  /// nothing; a change applies the stored values with the changes over them.
  static func picks(stored: [String: String], changes: [String: String], reset: Bool) -> [String: String]? {
    guard reset || !changes.isEmpty else { return nil }
    return (reset ? [:] : stored).merging(changes) { _, change in change }
  }
}
