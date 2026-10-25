import Foundation

/// The agent's title for a chat only exists in the live transcript; this keeps the latest one so
/// a list can show it without attaching. Scoped by host so equal chat names on two hosts stay apart.
final class ChatTitleStore: @unchecked Sendable {
  private let defaults: UserDefaults
  private let scope: String

  init(scope: String, defaults: UserDefaults = .standard) {
    self.scope = scope
    self.defaults = defaults
  }

  static func scope(for config: SSHConnectionConfig) -> String { "\(config.host):\(config.port)" }

  convenience init(config: SSHConnectionConfig) { self.init(scope: Self.scope(for: config)) }

  private func key(_ name: String) -> String { "tether.acp.title.\(scope).\(name)" }

  func title(for name: String) -> String? {
    defaults.string(forKey: key(name)).flatMap { $0.isEmpty ? nil : $0 }
  }

  func set(_ title: String, for name: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, self.title(for: name) != trimmed else { return }
    defaults.set(trimmed, forKey: key(name))
  }

  func clear(_ name: String) { defaults.removeObject(forKey: key(name)) }

  func titles(for names: [String]) -> [String: String] {
    var found: [String: String] = [:]
    for name in names { if let title = title(for: name) { found[name] = title } }
    return found
  }
}
