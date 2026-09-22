import Foundation

/// The read loop behind one-shot and streaming exec. libssh2 reports a timeout
/// when a command is merely quiet, so that keeps waiting, up to `deadline`
/// when there is one. Any other error is a dead transport and throws: returning
/// the partial output would pass it off as the command's answer.
enum ExecReader {
  static func run(
    read: (UnsafeMutableBufferPointer<CChar>) -> Int,
    isEOF: () -> Bool,
    now: () -> TimeInterval,
    deadline: TimeInterval?,
    onChunk: (UnsafeRawBufferPointer) -> Bool
  ) throws {
    var buffer = [CChar](repeating: 0, count: 16 * 1024)
    let start = now()
    while true {
      let count = buffer.withUnsafeMutableBufferPointer { read($0) }
      if count > 0 {
        let keepGoing = buffer.withUnsafeBytes { onChunk(UnsafeRawBufferPointer(rebasing: $0.prefix(count))) }
        if !keepGoing { return }
      } else if count == 0 {
        if isEOF() { return }
      } else if count != LibSSH2Const.timeout, count != LibSSH2Const.eagain {
        throw LibSSH2OpsError.readFailed(count)
      }
      if let deadline, now() - start > deadline { throw SSHConnectError.commandTimedOut }
    }
  }
}
