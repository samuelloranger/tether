import Foundation

/// A thin actor over a `URLSessionWebSocketTask` that carries the binary Noise
/// wire frames. The Noise handshake and every sealed application frame are
/// binary; the pairing route's final `{ok}` verdict arrives as a text frame, so
/// `recv()` folds a text frame into its UTF-8 bytes rather than rejecting it.
public actor NoiseTransport {
  private let task: URLSessionWebSocketTask
  private var closed = false

  public init(task: URLSessionWebSocketTask) {
    self.task = task
    task.resume()
  }

  public func send(_ frame: Data) async throws {
    try await task.send(.data(frame))
  }

  public func recv() async throws -> Data {
    let message = try await task.receive()
    switch message {
    case let .data(data):
      return data
    case let .string(text):
      return Data(text.utf8)
    @unknown default:
      throw NoiseTransportError.unexpectedFrame
    }
  }

  public func close() {
    guard !closed else { return }
    closed = true
    task.cancel(with: .goingAway, reason: nil)
  }
}

public enum NoiseTransportError: Error, LocalizedError {
  case unexpectedFrame

  public var errorDescription: String? {
    switch self {
    case .unexpectedFrame:
      "WebSocket delivered an unexpected frame type"
    }
  }
}
