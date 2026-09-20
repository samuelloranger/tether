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
  @Environment(\.scenePhase) private var scenePhase
  @State private var store = SessionStore()
  @State private var preferences = AppPreferences()

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
      } else if AgentChatDemoRoot.launchState != nil {
        AgentChatDemoRoot()
          .tint(TetherColors.accent)
      } else {
        appRoot
      }
      #else
      appRoot
      #endif
    }
  }

  // v5: SSH-first root. The Noise SessionStore/RootView remain in the repo but
  // are no longer rooted; they are removed in the final deletion phase.
  @ViewBuilder private var appRoot: some View {
    AppRootView(pushIdentityProvider: { appDelegate.pushRegistrar.pushIdentity() })
        .tint(TetherColors.accent)
        #if canImport(UIKit)
        .task {
          // Device-token registration is transport-agnostic; the SSH notify path
          // (tether-notify) reuses it later.
          appDelegate.pushRegistrar.start()
        }
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

  @MainActor
  func attach(store: SessionStore) {
    tapRouter.onOpenURL = { [weak store] url in
      store?.handleDeepLink(url)
    }
    tapRouter.isViewingSession = { [weak store] sessionId, identityName in
      guard let store else { return false }
      guard store.activeSessionId == sessionId else { return false }
      guard let host = store.hosts.first(where: { $0.id == store.activeHostId }) else {
        return false
      }
      return host.identityName == identityName
    }
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
