import CLibSSH2
import Foundation

enum LibSSH2TransportProbe {
  static func openInteractiveChannel(
    session: OpaquePointer,
    terminal: String = "xterm-256color",
    columns: Int32 = 80,
    rows: Int32 = 24
  ) -> OpaquePointer? {
    guard let channel = tether_libssh2_channel_open_session(session) else { return nil }
    let ptyStatus = terminal.withCString {
      tether_libssh2_channel_request_pty(channel, $0, UInt32(terminal.utf8.count), columns, rows)
    }
    guard ptyStatus == 0, tether_libssh2_channel_shell(channel) == 0 else {
      libssh2_channel_free(channel)
      return nil
    }
    return channel
  }

  @discardableResult
  static func read(into buffer: UnsafeMutableBufferPointer<CChar>, from channel: OpaquePointer) -> Int {
    tether_libssh2_channel_read(channel, buffer.baseAddress, buffer.count)
  }
}
