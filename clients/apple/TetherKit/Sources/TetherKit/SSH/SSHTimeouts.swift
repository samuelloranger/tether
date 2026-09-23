import Foundation

/// Kernel options catch a dead peer in ~25 s idle (keepalive idle + interval x count), 15 s
/// with bytes unacked. libssh2's timeout counts whole seconds, so it only bounds hangs.
enum SSHTimeouts {
  static let connectSeconds: Int32 = 8
  static let operationMs = 15_000
  static let commandSeconds: TimeInterval = 90
  static let keepaliveSeconds: UInt32 = 15
  static let tcpKeepIdleSeconds: Int32 = 10
  static let tcpKeepIntervalSeconds: Int32 = 5
  static let tcpKeepCount: Int32 = 3
  static let retransmitDropSeconds: Int32 = 15
}
