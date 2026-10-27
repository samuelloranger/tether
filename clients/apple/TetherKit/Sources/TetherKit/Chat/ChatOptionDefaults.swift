import Foundation

/// Model, effort and mode follow the user from chat to chat: a confirmed change is stored and a new
/// session gets it back once the agent has answered.
enum ChatOptionDefaults {
  static let rememberedIds = ["model", "effort", "mode"]

  static func remembers(_ id: String) -> Bool { rememberedIds.contains(id) }

  /// The `set_config_option` calls for a session just created, in a fixed order. A stored value the
  /// agent does not offer, or that already is the current one, is skipped.
  static func plan(stored: [String: String], offered: [ACPConfigOption]) -> [(id: String, value: String)] {
    rememberedIds.compactMap { id in
      guard let value = stored[id], let option = offered.first(where: { $0.id == id }),
        option.currentValue != value, option.choices.contains(where: { $0.value == value })
      else { return nil }
      return (id, value)
    }
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
    guard ChatOptionDefaults.remembers(id) else { return }
    lock.lock(); defer { lock.unlock() }
    var everything = all()
    everything[agent, default: [:]][id] = value
    defaults.set(try? JSONEncoder().encode(everything), forKey: Self.key)
  }
}
