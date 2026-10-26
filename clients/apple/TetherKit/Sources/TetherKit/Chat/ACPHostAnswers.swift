import Foundation

/// One-off host commands that must never hold a chat open: a failed connection, a missing command
/// and a slow host all give nil.
enum ACPHostExec {
  static let deadline: TimeInterval = 8

  static func run(
    command: String, config: SSHConnectionConfig, store: HostKeyStore, deadline: TimeInterval = ACPHostExec.deadline
  ) async -> String? {
    let output = LockedBox("")
    return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
      let gate = LockedBox(false)
      @Sendable func finish(_ value: String?) {
        let first = gate.update { done -> Bool in
          defer { done = true }
          return !done
        }
        if first { continuation.resume(returning: value) }
      }
      let task = Task {
        do {
          try await SSHConnector.execStream(config: config, store: store, command: command) { chunk in
            output.value += chunk
            return true
          }
          finish(output.value)
        } catch {
          finish(nil)
        }
      }
      Task {
        try? await Task.sleep(for: .seconds(deadline))
        finish(nil)
        task.cancel()
      }
    }
  }
}

enum ACPHostAnswers {
  static let deadline = ACPHostExec.deadline

  /// A host without the command, a failed connection and a slow one all give nil: the replay
  /// then simply shows the permission as the log left it.
  static func read(name: String, config: SSHConnectionConfig, store: HostKeyStore) async -> String? {
    let command = ACPAnswerCommand.answersCommand(notify: "PATH=\"$HOME/.local/bin:$PATH\" tether-notify", acp: name)
      + " 2>/dev/null"
    return await ACPHostExec.run(command: command, config: config, store: store)
  }
}

enum ACPHostInspect {
  /// The host's row for this chat, nil when the host can't say or has no such chat.
  static func summary(name: String, config: SSHConnectionConfig, store: HostKeyStore) async -> ACPChatSummary? {
    guard let output = await ACPHostExec.run(command: ACPHostCommand.list + " 2>/dev/null", config: config, store: store)
    else { return nil }
    return ACPChatListing.parse(output).chats.first { $0.name == name }
  }
}
