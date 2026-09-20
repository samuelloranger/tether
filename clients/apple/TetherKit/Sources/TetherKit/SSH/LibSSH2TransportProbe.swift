import CLibSSH2
import Foundation

/// Internal libssh2 bridge used by the disposable channel adapter.
/// Authentication, host verification, and socket ownership remain outside this spike.
enum LibSSH2TransportProbe {
  /// `LIBSSH2_ERROR_EAGAIN` (`Sources/CLibSSH2/include/libssh2.h`). Returned by
  /// channel read/write when the session is nonblocking and the operation
  /// would block — callers must retry, never treat it as fatal or as EOF.
  static let wouldBlockStatus = -37

  static var libraryVersion: String {
    guard let version = libssh2_version(0) else { return "" }
    return String(cString: version)
  }

  /// Performs the transport handshake after the caller creates `session` for `socket`.
  /// Authentication and host verification deliberately remain the caller's responsibility.
  @discardableResult
  static func handshake(session: OpaquePointer, socket: Int32) -> Bool {
    libssh2_session_handshake(session, socket) == 0
  }

  /// Opens an interactive channel on an already handshaken and authenticated session.
  /// Returns `nil` when pty allocation or shell startup fails.
  static func openInteractiveChannel(
    session: OpaquePointer,
    terminal: String = "xterm-256color",
    columns: Int32 = 80,
    rows: Int32 = 24
  ) -> OpaquePointer? {
    guard let channel = tether_libssh2_channel_open_session(session)
    else { return nil }

    let ptyStatus = terminal.withCString {
      tether_libssh2_channel_request_pty(
        channel, $0, UInt32(terminal.utf8.count), columns, rows
      )
    }
    guard ptyStatus == 0, tether_libssh2_channel_shell(channel) == 0 else {
      libssh2_channel_free(channel)
      return nil
    }
    return channel
  }

  @discardableResult
  static func write(_ bytes: Data, to channel: OpaquePointer) -> Int {
    bytes.withUnsafeBytes { rawBuffer in
      tether_libssh2_channel_write(
        channel,
        rawBuffer.baseAddress?.assumingMemoryBound(to: CChar.self),
        rawBuffer.count
      )
    }
  }

  @discardableResult
  static func read(into buffer: UnsafeMutableBufferPointer<CChar>, from channel: OpaquePointer) -> Int {
    tether_libssh2_channel_read(channel, buffer.baseAddress, buffer.count)
  }
}
