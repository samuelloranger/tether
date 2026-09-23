import Foundation
import UserNotifications

/// Routes notification taps into `DeepLinkCoordinator` and suppresses foreground
/// banners for the session the user is already viewing.
@MainActor
public final class NotificationTapRouter: NSObject, UNUserNotificationCenterDelegate {
  /// Invoked with a `tether://…` URL when a notification is tapped.
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

  /// Only `tether://` URLs are accepted — the payload is server-influenced.
  /// `nonisolated` so this pure parser stays testable off the main actor.
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
