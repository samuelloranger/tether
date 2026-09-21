import Foundation

protocol TerminalByteStream: Sendable {
  func read() async throws -> Data?
  func write(_ bytes: Data) async throws
  func close() async
  func resize(cols: UInt16, rows: UInt16) async
}

extension TerminalByteStream {
  func resize(cols: UInt16, rows: UInt16) async {}
}
