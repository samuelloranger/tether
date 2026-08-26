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
      RootView(store: store, preferences: preferences)
        .onOpenURL { url in
          store.handleDeepLink(url)
        }
        #if canImport(UIKit)
        .onAppear {
          appDelegate.attach(store: store)
        }
        #endif
        .task {
          await store.bootstrap()
          #if canImport(UIKit)
          appDelegate.pushRegistrar.start()
          #endif
        }
        .onChange(of: scenePhase) { _, phase in
          switch phase {
          case .active:
            store.handleAppLifecycle(.active)
          case .inactive, .background:
            store.handleAppLifecycle(.inactive)
          @unknown default:
            break
          }
        }
    }
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
