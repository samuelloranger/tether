import Foundation

enum ACPHostAnswers {
  static let deadline: TimeInterval = 8

  /// A host without the command, a failed connection and a slow one all give nil: the replay
  /// then simply shows the permission as the log left it.
  static func read(name: String, config: SSHConnectionConfig, store: HostKeyStore) async -> String? {
    let command = ACPAnswerCommand.answersCommand(notify: "PATH=\"$HOME/.local/bin:$PATH\" tether-notify", acp: name)
      + " 2>/dev/null"
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
