import Foundation

/// libssh2 return codes and hash ids used across the SSH transport.
enum LibSSH2Const {
  static let eagain: Int = -37
  static let timeout: Int = -9
  static let authenticationFailed: Int32 = -18
  static let publickeyUnverified: Int32 = -19
  static let hostKeyHashSHA256: Int32 = 3
  static let blockOutbound: Int32 = 0x0002 // LIBSSH2_SESSION_BLOCK_OUTBOUND
}
