import SwiftUI
import TetherKit

#if canImport(UIKit)
import UIKit
import UserNotifications
#endif

@main
struct TetherIOSApp: App {
  #if canImport(UIKit)
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  #endif

  var body: some Scene {
    WindowGroup {
      #if DEBUG
      if ProcessInfo.processInfo.environment["TETHER_SSH_LIVE"] != nil {
        AppRootView(demoModel: .liveDemoFromEnv())
          .tint(TetherColors.accent)
          .preferredColorScheme(.dark)
      } else if ProcessInfo.processInfo.environment["TETHER_SSH_DEMO"] != nil {
        AppRootView(demoModel: .preview())
          .tint(TetherColors.accent)
          .preferredColorScheme(.dark)
      } else if ProcessInfo.processInfo.environment["TETHER_HOME_PREVIEW"] != nil {
        HomeView(
          model: .preview(),
          initialTab: ProcessInfo.processInfo.environment["TETHER_HOME_TAB"] == "keys" ? .keys : .machines,
          onOpen: { _ in }
        )
        .tint(TetherColors.accent)
        .preferredColorScheme(.dark)
      } else {
        appRoot
      }
      #else
      appRoot
      #endif
    }
  }

  @ViewBuilder private var appRoot: some View {
    AppRootView(pushIdentityProvider: { appDelegate.pushRegistrar.pushIdentity() })
      .tint(TetherColors.accent)
      #if canImport(UIKit)
      .task { appDelegate.pushRegistrar.start() }
      #endif
  }
}

#if canImport(UIKit)
final class AppDelegate: NSObject, UIApplicationDelegate {
  let pushRegistrar = PushRegistrar()
  let tapRouter = NotificationTapRouter()

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = tapRouter
    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Task { @MainActor in
      pushRegistrar.handleDeviceToken(deviceToken)
    }
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    Task { @MainActor in
      pushRegistrar.handleRegistrationFailure(error)
    }
  }
}
#endif
