import CryptoKit
import Foundation

enum SSHKeyEncoding {
  static func openSSHPublicKey(rawEd25519 pub: Data, comment: String?) -> String {
    var blob = Data()
    blob.append(sshString("ssh-ed25519".data(using: .utf8)!))
    blob.append(sshString(pub))
    var line = "ssh-ed25519 " + blob.base64EncodedString()
    if let comment, !comment.isEmpty { line += " " + comment }
    return line
  }

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

  static func fingerprint(openSSHPublicKey line: String) -> String {
    let parts = line.split(separator: " ")
    guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return "" }
    let digest = SHA256.hash(data: blob)
    let b64 = Data(digest).base64EncodedString().replacingOccurrences(of: "=", with: "")
    return "SHA256:" + b64
  }

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
