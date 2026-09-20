import Foundation

enum SSHCredential: Equatable, Sendable {
  case password(String)
  case privateKey(pem: String, passphrase: String?)
}

enum SSHAuthError: Error, Equatable {
  case noCredentials
  case allFailed
}

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
