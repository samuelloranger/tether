import Foundation

/// Every bound the transport puts on a network that stops answering.
///
/// The kernel options catch a dead peer in about 25 s while idle (keepalive
/// idle + interval × count) and 15 s with bytes unacknowledged, whichever the
/// connection is doing. libssh2's timeout only bounds hangs: it counts in
/// whole seconds, so it is never used to pace a loop.
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
