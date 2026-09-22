import Foundation

enum SSHCredential: Equatable, Sendable {
  case password(String)
  case privateKey(pem: String, passphrase: String?)
}

enum SSHAuthError: Error, Equatable {
  case noCredentials
  /// `detail` is libssh2's own last error. A server that rejects the key and a
  /// client that cannot sign with it both land here, and they need different
  /// fixes, so the transport's reason has to survive the trip to the UI.
  case allFailed(detail: String?)
}

func authenticateInOrder(
  _ credentials: [SSHCredential],
  attempt: (SSHCredential) throws -> Bool
) throws -> SSHCredential {
  guard !credentials.isEmpty else { throw SSHAuthError.noCredentials }
  for credential in credentials where try attempt(credential) {
    return credential
  }
  throw SSHAuthError.allFailed(detail: nil)
}
