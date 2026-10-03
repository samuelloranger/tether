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
    // Actions need a session link and the agent state to check against; without them the
    // buttons could do nothing.
    guard let category = payload.category, Self.categories.contains(category),
          payload.link != nil, let state = payload.state, let version = payload.version, !version.isEmpty
    else {
      contentHandler(content)
      return
    }
    content.categoryIdentifier = category
    content.userInfo["agentState"] = state
    content.userInfo["agentVersion"] = version
    guard category == Self.questionCategory, let options = payload.options, (2...4).contains(options.count) else {
      contentHandler(content)
      return
    }
    Task {
      // Without the per-push category the push still offers Answer… from the static one.
      if let perPush = await Self.registerQuestionCategory(version: version, options: options) {
        content.categoryIdentifier = perPush
      }
      contentHandler(content)
    }
  }

  /// A question's one-tap options can only be buttons through a category made for this
  /// push. Mirrors `NotificationActions.questionCategory(version:options:)`; the extension
  /// doesn't link TetherKit.
  private static func registerQuestionCategory(version: String, options: [String]) async -> String? {
    let center = UNUserNotificationCenter.current()
    let identifier = questionCategoryPrefix + version
    let picks = options.enumerated().map { index, label in
      UNNotificationAction(identifier: "tether.action.option.\(index + 1)", title: label, options: [.authenticationRequired])
    }
    let answer = UNNotificationAction(
      identifier: "tether.action.answer", title: "Answer…", options: [.authenticationRequired, .foreground],
      icon: UNNotificationActionIcon(systemImageName: "list.bullet")
    )
    let category = UNNotificationCategory(identifier: identifier, actions: picks + [answer], intentIdentifiers: [])

    // Keep the newest few per-push categories: an older question may still be on screen.
    let defaults = UserDefaults.standard
    var recent = (defaults.stringArray(forKey: recentKey) ?? []).filter { $0 != identifier }
    recent.append(identifier)
    recent = Array(recent.suffix(keptQuestionCategories))
    defaults.set(recent, forKey: recentKey)

    let existing = await center.notificationCategories()
    let kept = existing.filter { !$0.identifier.hasPrefix(questionCategoryPrefix) || recent.contains($0.identifier) }
    center.setNotificationCategories(kept.union([category]))
    // The set lands asynchronously; reading it back waits for it before delivery.
    let registered = await center.notificationCategories()
    return registered.contains { $0.identifier == identifier } ? identifier : nil
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
    let category: String?
    let state: String?
    let version: String?
    let options: [String]?
  }

  // Mirrors NotificationActions.categoryIdentifiers; the extension doesn't link TetherKit.
  private static let questionCategory = "tether.agent.question"
  private static let questionCategoryPrefix = "tether.agent.question."
  private static let categories: Set<String> = ["tether.agent.waiting", "tether.agent.done", questionCategory]
  private static let recentKey = "tether.recentQuestionCategories"
  private static let keptQuestionCategories = 8

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
