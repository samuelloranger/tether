import SwiftUI
import TetherKit

@main
struct TetherIOSApp: App {
  @State private var store = SessionStore()

  var body: some Scene {
    WindowGroup {
      RootView(store: store)
        .preferredColorScheme(.dark)
        .onOpenURL { url in
          store.handleDeepLink(url)
        }
        .task {
          await store.bootstrap()
        }
    }
  }
}
