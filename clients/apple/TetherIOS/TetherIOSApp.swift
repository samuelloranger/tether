import SwiftUI
import TetherKit

@main
struct TetherIOSApp: App {
  @State private var store = SessionStore()
  @State private var preferences = AppPreferences()

  var body: some Scene {
    WindowGroup {
      RootView(store: store, preferences: preferences)
        .onOpenURL { url in
          store.handleDeepLink(url)
        }
        .task {
          await store.bootstrap()
        }
    }
  }
}
