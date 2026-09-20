import Foundation

/// A single way to authenticate an SSH session. Private-key material is carried
/// in memory (PEM) and handed straight to libssh2's from-memory auth — it is
/// never written to a temp file.
enum SSHCredential: Equatable, Sendable {
  case password(String)
  case privateKey(pem: String, passphrase: String?)
}

enum SSHAuthError: Error, Equatable {
  case noCredentials
  case allFailed
}

/// Tries credentials in order, returning the first that authenticates.
///
/// `attempt` returns `true` when the server accepted the credential and `false`
/// when it rejected it (try the next one). A thrown error is a transport-level
/// failure — it aborts immediately rather than masquerading as a rejection.
func authenticateInOrder(
  _ credentials: [SSHCredential],
  attempt: (SSHCredential) throws -> Bool
) throws -> SSHCredential {
  guard !credentials.isEmpty else { throw SSHAuthError.noCredentials }
  for credential in credentials where try attempt(credential) {
    return credential
  }
  throw SSHAuthError.allFailed
}
