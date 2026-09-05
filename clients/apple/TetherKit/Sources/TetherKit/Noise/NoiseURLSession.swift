import Foundation

/// URLSession for the Noise WS endpoints only. Accepts any server cert because
/// Noise (pinned static key), not TLS, authenticates the peer — so a self-signed
/// cert is not a downgrade. Never reuse for requests whose security needs the cert.
public enum NoiseURLSession {
  public static let shared: URLSession = URLSession(
    configuration: .ephemeral,
    delegate: NoiseServerTrustDelegate(),
    delegateQueue: nil
  )
}

final class NoiseServerTrustDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
  private func accept(
    _ challenge: URLAuthenticationChallenge,
    _ completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    if let trust = challenge.protectionSpace.serverTrust {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.performDefaultHandling, nil)
    }
  }

  // A URLSessionWebSocketTask delivers the server-trust challenge at the task
  // level; other requests deliver it at the session level. Handle both.
  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) { accept(challenge, completionHandler) }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) { accept(challenge, completionHandler) }
}
