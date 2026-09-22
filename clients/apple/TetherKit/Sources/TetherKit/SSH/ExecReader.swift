import Foundation

/// The read loop behind one-shot and streaming exec. libssh2 reports a timeout
/// when a command is merely quiet, so that keeps waiting, until it has been
/// silent for `deadline` when there is one. A blocking read returns 0 only at
/// EOF or close (and `libssh2_channel_eof` misses a close), so 0 ends the read.
/// Any other error is a dead transport and throws: returning the partial
/// output would pass it off as the command's answer.
enum ExecReader {
  static func run(
    read: (UnsafeMutableBufferPointer<CChar>) -> Int,
    now: () -> TimeInterval,
    deadline: TimeInterval?,
    onChunk: (UnsafeRawBufferPointer) -> Bool
  ) throws {
    var buffer = [CChar](repeating: 0, count: 16 * 1024)
    var lastHeard = now()
    while true {
      let count = buffer.withUnsafeMutableBufferPointer { read($0) }
      let time = now()
      if count > 0 {
        lastHeard = time
        let keepGoing = buffer.withUnsafeBytes { onChunk(UnsafeRawBufferPointer(rebasing: $0.prefix(count))) }
        if !keepGoing { return }
      } else if count == 0 {
        return
      } else if count != LibSSH2Const.timeout, count != LibSSH2Const.eagain {
        throw LibSSH2OpsError.readFailed(count)
      }
      if let deadline, time - lastHeard > deadline { throw SSHConnectError.commandTimedOut }
    }
  }
}
