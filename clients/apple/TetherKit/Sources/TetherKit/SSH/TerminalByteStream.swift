import CLibSSH2
import Foundation

/// The PTY byte boundary consumed by `TerminalPipeline`.
///
/// It intentionally knows nothing about hosts, credentials, or terminal grids:
/// implementations only deliver raw PTY bytes and accept raw terminal input.
protocol TerminalByteStream: Sendable {
  func read() async throws -> Data?
  func write(_ bytes: Data) async throws
  func close() async
}

/// Owns a libssh2 interactive channel after authentication and PTY setup.
///
/// The current XCFramework exposes the channel primitives but not a Swift-native
/// socket/auth lifecycle. Keeping that pointer here makes the pipeline depend
/// only on `TerminalByteStream`; the future authenticated connector can create
/// this adapter without exposing C pointers to UI or terminal code.
///
/// Ownership: this adapter owns the `LIBSSH2_CHANNEL` only. The
/// `LIBSSH2_SESSION` and the underlying socket stay with whoever created them
/// (the future connector) — `close()` frees just the channel, so the connector
/// must tear down session/socket after closing the adapter. Host-key
/// verification and auth likewise belong to the connector, never here.
actor LibSSH2ChannelByteStream: TerminalByteStream {
  private var channel: OpaquePointer?

  init(channel: OpaquePointer) {
    self.channel = channel
  }

  func read() async throws -> Data? {
    guard let channel else { return nil }
    var buffer = [CChar](repeating: 0, count: 16 * 1024)
    while true {
      // A cancelled read loop must not re-enter the blocking C call.
      try Task.checkCancellation()
      let count = buffer.withUnsafeMutableBufferPointer {
        LibSSH2TransportProbe.read(into: $0, from: channel)
      }
      if count > 0 {
        return Data(buffer.prefix(count).map(UInt8.init(bitPattern:)))
      }
      if count == 0 {
        // EOF / channel torn down. `nil` is the stream's closed signal, which
        // the pipeline turns into its "Connection closed" event.
        return nil
      }
      if count == LibSSH2TransportProbe.wouldBlockStatus {
        // Nonblocking session with no data yet: poll instead of failing the
        // read loop. The spike runs blocking sessions today, so this arm only
        // matters once the connector switches modes.
        try await Task.sleep(nanoseconds: 10_000_000)
        continue
      }
      throw LibSSH2ChannelError.readFailed(count)
    }
  }

  func write(_ bytes: Data) async throws {
    guard let channel else { throw LibSSH2ChannelError.closed }
    var offset = 0
    while offset < bytes.count {
      try Task.checkCancellation()
      // Slice via pointer arithmetic, not `Data(dropFirst:)`, to avoid a copy
      // per partial write.
      let written = bytes.withUnsafeBytes { raw -> Int in
        let base = raw.baseAddress!.assumingMemoryBound(to: CChar.self).advanced(by: offset)
        return tether_libssh2_channel_write(channel, base, bytes.count - offset)
      }
      if written > 0 {
        offset += written
        continue
      }
      if written == LibSSH2TransportProbe.wouldBlockStatus {
        try await Task.sleep(nanoseconds: 10_000_000)
        continue
      }
      throw LibSSH2ChannelError.writeFailed(written)
    }
  }

  func close() async {
    guard let channel else { return }
    self.channel = nil
    libssh2_channel_free(channel)
  }
}

private enum LibSSH2ChannelError: Error {
  case closed
  case readFailed(Int)
  case writeFailed(Int)
}
