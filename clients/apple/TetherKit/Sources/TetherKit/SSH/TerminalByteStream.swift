import Foundation

protocol TerminalByteStream: Sendable {
  func read() async throws -> Data?
  func write(_ bytes: Data) async throws
  func close() async
}
