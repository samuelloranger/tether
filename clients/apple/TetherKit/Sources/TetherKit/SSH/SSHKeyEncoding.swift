import CryptoKit
import Foundation

/// Byte-level SSH key formatting: OpenSSH public keys, PKCS#8 private PEM, and
/// SHA-256 fingerprints, matching what ssh-keygen/openssl produce.
enum SSHKeyEncoding {
  /// `ssh-ed25519 <base64 wire blob> [comment]`, where the blob is
  /// string("ssh-ed25519") + string(rawPublicKey).
  static func openSSHPublicKey(rawEd25519 pub: Data, comment: String?) -> String {
    var blob = Data()
    blob.append(sshString("ssh-ed25519".data(using: .utf8)!))
    blob.append(sshString(pub))
    var line = "ssh-ed25519 " + blob.base64EncodedString()
    if let comment, !comment.isEmpty { line += " " + comment }
    return line
  }

  /// A 32-byte ed25519 seed wrapped as an unencrypted PKCS#8 PEM. The fixed
  /// prefix is the ASN.1 header for a bare Ed25519 OneAsymmetricKey.
  static func pkcs8PEM(ed25519Seed seed: Data) -> String {
    let prefix = Data([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ])
    let body = (prefix + seed).base64EncodedString()
    let wrapped = stride(from: 0, to: body.count, by: 64).map { start -> String in
      let from = body.index(body.startIndex, offsetBy: start)
      let to = body.index(from, offsetBy: min(64, body.count - start))
      return String(body[from..<to])
    }.joined(separator: "\n")
    return "-----BEGIN PRIVATE KEY-----\n\(wrapped)\n-----END PRIVATE KEY-----\n"
  }

  /// `SHA256:<base64 of the SHA-256 of the wire blob, no padding>`.
  static func fingerprint(openSSHPublicKey line: String) -> String {
    let parts = line.split(separator: " ")
    guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return "" }
    let digest = SHA256.hash(data: blob)
    let b64 = Data(digest).base64EncodedString().replacingOccurrences(of: "=", with: "")
    return "SHA256:" + b64
  }

  /// The raw SHA-256 digest of the public-key wire blob — the input the
  /// randomart walk consumes.
  static func fingerprintDigest(openSSHPublicKey line: String) -> Data? {
    let parts = line.split(separator: " ")
    guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return nil }
    return Data(SHA256.hash(data: blob))
  }

  private static func sshString(_ data: Data) -> Data {
    var out = Data()
    var length = UInt32(data.count).bigEndian
    withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
    out.append(data)
    return out
  }
}
