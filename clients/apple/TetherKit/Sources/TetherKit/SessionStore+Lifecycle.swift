import Foundation

/// App scene phase mapped without importing SwiftUI into SessionStore callers
/// that only care about active vs not.
public enum AppLifecyclePhase: Equatable, Sendable {
  case active
  case inactive
}
