import Foundation

/// The PTY byte boundary consumed by `TerminalPipeline`.
///
/// It intentionally knows nothing about hosts, credentials, or terminal grids:
/// implementations only deliver raw PTY bytes and accept raw terminal input.
/// `read()` returns `nil` once the stream is closed (EOF or teardown), which the
/// pipeline turns into its "Connection closed" event.
protocol TerminalByteStream: Sendable {
  func read() async throws -> Data?
  func write(_ bytes: Data) async throws
  func close() async
}
