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

  init() {
    #if DEBUG
    if let id = ProcessInfo.processInfo.environment["TETHER_THEME"] { ChromeTheme.shared.apply(.named(id)) }
    #endif
    TetherMacWindow.applyBarAppearance()
  }

  var body: some Scene {
    WindowGroup {
      content
        .onAppear { TetherMacWindow.configureScenes() }
        .onChange(of: scenePhase) { _, phase in
          if phase == .active { TetherMacWindow.configureScenes() }
        }
    }
    #if targetEnvironment(macCatalyst)
    .commands { TetherCommands() }
    #endif
  }

  @ViewBuilder private var content: some View {
      #if DEBUG
      if ProcessInfo.processInfo.environment["TETHER_SSH_LIVE"] != nil {
        AppRootView(demoModel: .liveDemoFromEnv())
      } else if ProcessInfo.processInfo.environment["TETHER_SSH_DEMO"] != nil {
        AppRootView(demoModel: .preview())
      } else if ProcessInfo.processInfo.environment["TETHER_HOME_PREVIEW"] != nil {
        HomeView(
          model: .preview(),
          initialTab: ProcessInfo.processInfo.environment["TETHER_HOME_TAB"] == "keys" ? .keys : .machines,
          onOpen: { _ in }
        )
        .tint(TetherColors.accent)
        .preferredColorScheme(ChromeTheme.shared.isLight ? .light : .dark)
      } else {
        appRoot
      }
      #else
      appRoot
      #endif
  }

  @ViewBuilder private var appRoot: some View {
    AppRootView(
      pushIdentityProvider: { appDelegate.pushRegistrar.pushIdentity() },
      notificationRouter: appDelegate.tapRouter,
      questionRunner: appDelegate.actionRunner
    )
      #if canImport(UIKit)
      .task { appDelegate.pushRegistrar.start() }
      #endif
  }
}

#if canImport(UIKit)
final class AppDelegate: UIResponder, UIApplicationDelegate {
  let pushRegistrar = PushRegistrar()
  let tapRouter = NotificationTapRouter()
  lazy var actionRunner = NotificationActionRunner.live()

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let center = UNUserNotificationCenter.current()
    center.delegate = tapRouter
    center.getNotificationCategories { existing in
      center.setNotificationCategories(NotificationActions.launchCategories(existing: existing))
    }
    tapRouter.onAction = { [weak self] attempt in await self?.actionRunner.perform(attempt) }
    return true
  }

  #if targetEnvironment(macCatalyst)
  override func buildMenu(with builder: any UIMenuBuilder) {
    super.buildMenu(with: builder)
    TetherMacWindow.removeDeadMenus(from: builder)
  }
  #endif

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
