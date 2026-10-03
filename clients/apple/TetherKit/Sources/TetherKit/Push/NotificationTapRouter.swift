import Foundation
import UserNotifications

/// Routes notification taps into `DeepLinkCoordinator` and hands foreground pushes
/// about the open host to its in-app banner.
@MainActor
public final class NotificationTapRouter: NSObject, UNUserNotificationCenterDelegate {
  /// Invoked with a `tether://…` URL when a notification is tapped. A tap that launches
  /// the app arrives before the UI sets this, so it is held until then.
  public var onOpenURL: ((URL) -> Void)? {
    didSet {
      guard let onOpenURL, let pending = pendingURL else { return }
      pendingURL = nil
      onOpenURL(pending)
    }
  }
  private var pendingURL: URL?
  public var hasPendingURL: Bool { pendingURL != nil }

  /// Invoked when Answer… is tapped on a question; held like `onOpenURL` until the UI sets it.
  public var onOpenQuestion: ((AgentQuestionTarget) -> Void)? {
    didSet {
      guard let onOpenQuestion, let pending = pendingQuestion else { return }
      pendingQuestion = nil
      onOpenQuestion(pending)
    }
  }
  private var pendingQuestion: AgentQuestionTarget?
  /// A launch from Answer… must not reopen the last machine: attaching its session would
  /// release the question to the terminal.
  public var hasPendingQuestion: Bool { pendingQuestion != nil }

  /// Set while a terminal is open: true when that terminal shows this push in-app.
  public var coversForegroundPush: (@MainActor (SessionDeepLink) async -> Bool)?

  /// Runs Approve / Deny / Reply. Set at launch, not by the UI: an action can wake the
  /// app in the background with no scene.
  public var onAction: (@MainActor (NotificationActionAttempt) async -> Void)?

  public override init() {
    super.init()
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let userInfo = notification.request.content.userInfo
    Task { @MainActor in completionHandler(await presentationOptions(for: userInfo)) }
  }

  func presentationOptions(for userInfo: [AnyHashable: Any]) async -> UNNotificationPresentationOptions {
    let shown: UNNotificationPresentationOptions = [.banner, .sound, .badge]
    guard let covers = coversForegroundPush,
          let link = Self.link(from: userInfo),
          let deep = DeepLinkCoordinator.parse(link)
    else { return shown }
    return await covers(deep) ? [] : shown
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if response.actionIdentifier != UNNotificationDefaultActionIdentifier {
      let text = (response as? UNTextInputNotificationResponse)?.userText
      let attempt = NotificationActions.attempt(
        actionIdentifier: response.actionIdentifier, text: text,
        userInfo: response.notification.request.content.userInfo
      )
      if case let .openQuestion(link, expect) = attempt {
        openQuestion(AgentQuestionTarget(link: link, expect: expect))
        return completionHandler()
      }
      guard let onAction, let attempt else { return completionHandler() }
      // The system keeps a backgrounded app alive until the handler runs.
      Task { @MainActor in
        await onAction(attempt)
        completionHandler()
      }
      return
    }
    defer { completionHandler() }
    guard let link = Self.link(from: response.notification.request.content.userInfo),
          let url = URL(string: link)
    else { return }
    open(url)
  }

  func open(_ url: URL) {
    if let onOpenURL { onOpenURL(url) } else { pendingURL = url }
  }

  func openQuestion(_ target: AgentQuestionTarget) {
    if let onOpenQuestion { onOpenQuestion(target) } else { pendingQuestion = target }
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
