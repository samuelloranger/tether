import Foundation

extension ChatAgentProfile {
  /// The agents whose adapter version the host manages (`tether acp agent`, `acp update`).
  var isHostManaged: Bool { key == ChatAgents.claude.key || key == ChatAgents.codex.key }

  /// What the host spawns: its managed agent where it has them, else this app's pinned command.
  func command(managed: Bool) -> String {
    managed && isHostManaged ? "tether acp agent \(key)" : spawn
  }
}

/// One line of `tether acp versions`: the ACP adapter chats run, or the agent's own CLI on the host.
struct ACPAgentVersion: Equatable, Sendable {
  enum Kind: String, Sendable { case adapter, cli }

  var kind: Kind = .adapter
  var agent: String
  var version: String
  var managed: Bool
  var engine: String
  var previous: String
  var latest: String
  var updateAvailable: Bool
  var error: String
  /// A CLI's updater; when not runnable it is what the user runs themselves.
  var command = ""
  var runnable = false

  var key: String { "\(kind.rawValue):\(agent)" }

  /// "Codex adapter 2.8.0 available · you have 2.3.0 (Codex 0.164.0)" or "Claude Code CLI 2.1.329 available · you have 2.1.327".
  func notice(label: String) -> String {
    switch kind {
    case .adapter:
      return "\(label) adapter \(latest) available · you have \(version)" + (engine.isEmpty ? "" : " (\(engine))")
    case .cli:
      return "\(Self.cliNames[agent] ?? label + " CLI") \(latest) available · you have \(version)"
    }
  }

  static let cliNames = ["claude": "Claude Code CLI", "codex": "Codex CLI", "opencode": "opencode CLI", "copilot": "Copilot CLI"]
}

enum ACPAgentVersions {
  enum Result: Equatable {
    /// Keyed by `ACPAgentVersion.key`.
    case supported([String: ACPAgentVersion])
    /// The host's tether predates managed agents.
    case unsupported
  }

  /// Nil when the output says neither: a failure the next read may not have.
  static func parse(_ output: String) -> Result? {
    var versions: [String: ACPAgentVersion] = [:]
    for line in output.split(whereSeparator: \.isNewline) {
      guard let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
        let agent = object["agent"] as? String, let version = object["version"] as? String
      else { continue }
      let line = ACPAgentVersion(
        kind: ACPAgentVersion.Kind(rawValue: object["kind"] as? String ?? "") ?? .adapter, agent: agent, version: version, managed: object["managed"] as? Bool ?? false,
        engine: object["engine"] as? String ?? "", previous: object["previous"] as? String ?? "",
        latest: object["latest"] as? String ?? "", updateAvailable: object["updateAvailable"] as? Bool ?? false,
        error: object["error"] as? String ?? "", command: object["command"] as? String ?? "",
        runnable: object["runnable"] as? Bool ?? false)
      versions[line.key] = line
    }
    if !versions.isEmpty { return .supported(versions) }
    let lower = output.lowercased()
    return lower.contains("unknown acp command") || lower.contains("usage:") ? .unsupported : nil
  }
}

/// Per host: whether its tether manages agents, and the adapter updates the user put off.
struct ChatManagedAgentsStore {
  private let scope: String
  private let defaults: UserDefaults

  init(scope: String, defaults: UserDefaults = .standard) {
    self.scope = scope
    self.defaults = defaults
  }

  init(config: SSHConnectionConfig) { self.init(scope: ChatTitleStore.scope(for: config)) }

  private var supportKey: String { "tether.acp.managedAgents.\(scope)" }
  private func dismissKey(_ version: ACPAgentVersion) -> String { "tether.acp.updateDismissed.\(scope).\(version.key)" }

  var supported: Bool {
    get { defaults.bool(forKey: supportKey) }
    nonmutating set { defaults.set(newValue, forKey: supportKey) }
  }

  func record(_ result: ACPAgentVersions.Result) {
    if case .supported = result { supported = true } else { supported = false }
  }

  /// Not now hides one version; a newer one shows again.
  func isDismissed(_ version: ACPAgentVersion) -> Bool { defaults.string(forKey: dismissKey(version)) == version.latest }
  func dismiss(_ version: ACPAgentVersion) { defaults.set(version.latest, forKey: dismissKey(version)) }
}

extension ACPHostCommand {
  static let versions = "PATH=\"$HOME/.local/bin:$PATH\" tether acp versions 2>&1"

  static func update(_ version: ACPAgentVersion) -> String {
    "PATH=\"$HOME/.local/bin:$PATH\" tether acp update \(shellQuote(version.agent))" + (version.kind == .cli ? " --cli" : "") + " 2>&1"
  }

  /// The options a new session in `cwd` starts with; runs the agent briefly on the host.
  static func options(cwd: String, agent: ChatAgentProfile, managed: Bool) -> String {
    "PATH=\"$HOME/.local/bin:$PATH\" tether acp options \(shellQuote(cwd)) --agent-cmd \(shellQuote(agent.command(managed: managed))) 2>&1"
  }

  /// Nil once the host reported the switch, else what to show.
  static func updateFailure(_ output: String) -> String? {
    for line in output.split(whereSeparator: \.isNewline) {
      if let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any], object["to"] != nil {
        return nil
      }
    }
    let text = output.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "tether: ", with: "")
    return text.isEmpty ? "The host didn't confirm the update." : String(text.prefix(240))
  }

  static func parseOptions(_ output: String) -> [ACPConfigOption]? {
    for line in output.split(whereSeparator: \.isNewline) {
      if let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
        let raw = object["configOptions"] as? [[String: Any]]
      {
        return ACPDecoder.configOptions(raw)
      }
    }
    return nil
  }
}
