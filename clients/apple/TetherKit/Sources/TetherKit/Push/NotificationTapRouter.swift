import Foundation
import UserNotifications

/// Routes notification taps into the existing `DeepLinkCoordinator` path and
/// suppresses foreground banners for the session the user is already viewing
/// (client-side mirror of the server's `focused` subscriber check).
@MainActor
public final class NotificationTapRouter: NSObject, UNUserNotificationCenterDelegate {
  /// Feeds a `tether://…` URL into `SessionStore.handleDeepLink`.
  public var onOpenURL: ((URL) -> Void)?

  /// Returns true when the user is currently viewing `sessionId` on the host
  /// whose `identityName` matches — used by `willPresent` to hide the banner.
  public var isViewingSession: ((_ sessionId: String, _ identityName: String) -> Bool)?

  public override init() {
    super.init()
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if let link = Self.link(from: notification.request.content.userInfo),
       let deep = DeepLinkCoordinator.parse(link),
       isViewingSession?(deep.sessionId, deep.identityName) == true
    {
      completionHandler([])
      return
    }
    completionHandler([.banner, .sound, .badge])
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
    guard let link = Self.link(from: response.notification.request.content.userInfo),
          let url = URL(string: link)
    else { return }
    onOpenURL?(url)
  }

  /// Prefer `link` (written by the NSE after decrypt, or by cleartext pushes).
  /// Only `tether://` URLs are accepted — the payload is server-influenced.
  ///
  /// `nonisolated` because it is a pure parser: it reads a dictionary and
  /// returns a string. The class is `@MainActor` for the delegate callbacks,
  /// and inheriting that here made the one piece of logic worth testing
  /// callable only from the main actor.
  public nonisolated static func link(from userInfo: [AnyHashable: Any]) -> String? {
    if let link = userInfo["link"] as? String, link.hasPrefix("tether://") {
      return link
    }
    // Fallback if a future payload stamps session + host directly.
    if let sessionId = userInfo["sessionId"] as? String,
       let host = userInfo["host"] as? String,
       !sessionId.isEmpty,
       !host.isEmpty
    {
      var components = URLComponents()
      components.scheme = "tether"
      components.host = "session"
      components.path = "/\(sessionId)"
      components.queryItems = [URLQueryItem(name: "host", value: host)]
      return components.url?.absoluteString
    }
    return nil
  }
}
