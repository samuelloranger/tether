import CryptoKit
import Security
import UserNotifications

// Decrypts push payloads on-device — the relay only sees `e`, base64(nonce[12]
// || ciphertext || tag[16]). On any failure we keep the relay's generic fallback.
class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let mutable = request.content.mutableCopy() as? UNMutableNotificationContent
    bestAttempt = mutable
    guard let content = mutable else {
      contentHandler(request.content)
      return
    }

    guard
      let sealedBase64 = request.content.userInfo["e"] as? String,
      let key = Self.loadSecretKey(),
      let plaintext = Self.decrypt(base64: sealedBase64, key: key),
      let payload = try? JSONDecoder().decode(PushContent.self, from: plaintext)
    else {
      // Keep the generic fallback rather than surfacing an error to the user.
      contentHandler(content)
      return
    }

    content.title = payload.title
    content.body = payload.body
    if let link = payload.link {
      content.userInfo["link"] = link
    }
    contentHandler(content)
  }

  /// iOS gives the extension ~30s. If it expires, show the untouched fallback.
  override func serviceExtensionTimeWillExpire() {
    if let handler = contentHandler, let content = bestAttempt {
      handler(content)
    }
  }

  private struct PushContent: Decodable {
    let title: String
    let body: String
    let link: String?
  }

  // Reads the AES key PushRegistrar wrote, via the shared keychain group. The
  // extension has its own bundle id, so without that group this returns nothing.
  private static func loadSecretKey() -> SymmetricKey? {
    // kSecAttrAccessGroup omitted on purpose: without it the query searches every
    // entitled group; naming it would hardcode the signing-time team-id prefix.
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "dev.tether.app",
      kSecAttrAccount as String: "tether_push_secret",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard
      SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data,
      let base64 = String(data: data, encoding: .utf8),
      let raw = Data(base64Encoded: base64),
      raw.count == 32
    else {
      return nil
    }
    return SymmetricKey(data: raw)
  }

  private static func decrypt(base64: String, key: SymmetricKey) -> Data? {
    guard let raw = Data(base64Encoded: base64), raw.count > 12 + 16 else { return nil }
    let nonceBytes = raw.prefix(12)
    let remainder = raw.dropFirst(12)
    // CryptoKit wants ciphertext and the 16-byte tag separated; the wire format
    // has them adjacent because WebCrypto appends the tag on the server side.
    let ciphertext = remainder.dropLast(16)
    let tag = remainder.suffix(16)
    guard
      let nonce = try? AES.GCM.Nonce(data: nonceBytes),
      let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
    else {
      return nil
    }
    return try? AES.GCM.open(box, using: key)
  }
}
