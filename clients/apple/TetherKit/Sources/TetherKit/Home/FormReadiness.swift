import Foundation

/// Why a form's primary action is still unavailable, in the order the form asks
/// for its fields. `nil` means the form is ready. A dimmed button on its own
/// explains nothing — this is the sentence shown beside it and read as its hint.
public enum FormReadiness {
  public static func serverBlocker(
    name: String, host: String, username: String, usesPassword: Bool, password: String, hasKey: Bool
  ) -> String? {
    if isBlank(name) { return "Name this machine to save it" }
    if isBlank(host) { return "Add a host to save it" }
    if isBlank(username) { return "Add a user to save it" }
    if usesPassword { return password.isEmpty ? "Enter a password to save it" : nil }
    return hasKey ? nil : "Choose a key to save it"
  }

  public static func keyBlocker(
    name: String, needsMaterial: Bool, pem: String, publicKey: String
  ) -> String? {
    if isBlank(name) { return "Name this key to save it" }
    guard needsMaterial else { return nil }
    // Same shape checks the form already enforced, now with a reason attached.
    if !pem.contains("PRIVATE KEY") { return "Paste the private key to save it" }
    let trimmedPublic = publicKey.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmedPublic.hasPrefix("ssh-") ? nil : "Paste the public key to save it"
  }

  private static func isBlank(_ value: String) -> Bool {
    value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}
