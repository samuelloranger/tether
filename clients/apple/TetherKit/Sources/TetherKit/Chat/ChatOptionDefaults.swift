import Foundation

/// Model, effort and mode follow the user from chat to chat: a confirmed change is stored and a new
/// session gets it back once the agent has answered.
enum ChatOptionDefaults {
  static let rememberedIds = ["model", "effort", "mode"]

  static func remembers(_ id: String) -> Bool { rememberedIds.contains(id) }

  /// The next `set_config_option` for a session just created, given the options as they stand now:
  /// the effort choices depend on the model, so this is asked again after every answer. `skipping`
  /// holds the ids already tried or changed by the user. A stored value the agent does not offer,
  /// or that already is the current one, is skipped.
  static func next(
    stored: [String: String], offered: [ACPConfigOption], skipping: Set<String>,
    remembered: [String] = ChatOptionDefaults.rememberedIds
  ) -> (id: String, value: String)? {
    for id in remembered where !skipping.contains(id) {
      guard let value = stored[id], let option = offered.first(where: { $0.id == id }),
        option.currentValue != value, option.choices.contains(where: { $0.value == value })
      else { continue }
      return (id, value)
    }
    return nil
  }
}

/// `{agentKey: {optionId: value}}`, per device.
final class ChatOptionDefaultsStore: @unchecked Sendable {
  private static let key = "tether.acp.optionDefaults"
  private let defaults: UserDefaults
  private let lock = NSLock()

  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  private func all() -> [String: [String: String]] {
    defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([String: [String: String]].self, from: $0) } ?? [:]
  }

  func stored(agent: String) -> [String: String] {
    lock.lock(); defer { lock.unlock() }
    return all()[agent] ?? [:]
  }

  func remember(agent: String, id: String, value: String) {
    guard ChatAgents.profile(forKey: agent)?.remembers(id) == true else { return }
    lock.lock(); defer { lock.unlock() }
    var everything = all()
    everything[agent, default: [:]][id] = value
    defaults.set(try? JSONEncoder().encode(everything), forKey: Self.key)
  }
}
