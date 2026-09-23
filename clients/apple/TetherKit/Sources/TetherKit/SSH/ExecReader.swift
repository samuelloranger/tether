import Foundation

/// libssh2 times out on a merely quiet command, so a timeout keeps waiting; 0 means EOF or close
/// (`libssh2_channel_eof` misses a close). Other errors throw rather than pass off partial output.
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
