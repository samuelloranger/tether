import Foundation

enum SSHCredential: Equatable, Sendable {
  case password(String)
  case privateKey(pem: String, passphrase: String?)
}

enum SSHAuthError: Error, Equatable {
  case noCredentials
  /// A server rejecting the key and a client failing to sign both land here and
  /// need different fixes, so `detail` carries libssh2's own reason.
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
