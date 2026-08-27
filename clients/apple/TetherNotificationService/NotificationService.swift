import CryptoKit
import Security
import UserNotifications

/// Decrypts Tether push payloads before iOS displays them.
///
/// The relay only ever sees `e` — base64( nonce[12] || ciphertext || tag[16] ) —
/// so the readable title and body exist only here, on the device. If anything
/// below fails we fall through to the generic text the relay set, which reveals
/// nothing.
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

  /// Reads the AES key `PushRegistrar` wrote in the app, via the shared
  /// keychain access group. The extension has its own bundle id, so without
  /// that shared group this lookup returns nothing and every push shows the
  /// fallback.
  private static func loadSecretKey() -> SymmetricKey? {
    // Match PushRegistrar's service + account. kSecAttrAccessGroup is omitted
    // on purpose: a query without it searches every group this binary is
    // entitled to (including the shared app group). Naming the group would
    // hardcode the team-id prefix that only resolves at signing time.
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
