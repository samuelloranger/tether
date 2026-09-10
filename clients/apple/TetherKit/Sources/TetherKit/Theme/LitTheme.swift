import Foundation
import SwiftUI

/// What the chrome is wearing. `none` is not "idle": a stopped or absent session
/// must not tint the app, or a dead shell reads as a live one.
public enum LitState: String, Equatable, Sendable {
  case working
  case waiting
  case done
  case idle
  case none
}

/// Bloom alphas for the glow, per-state: ember reads hotter than amber at equal
/// alpha, so waiting is scaled quieter; idle quieter still; none zeroed.
public struct LitBloom: Equatable, Sendable {
  public var b1: Double
  public var b2: Double
  public var b3: Double
  public var rim: Double

  public static let working = LitBloom(b1: 0.13, b2: 0.06, b3: 0.02, rim: 0.55)
  public static let waiting = LitBloom(b1: 0.09, b2: 0.04, b3: 0.015, rim: 0.46)
  // Between waiting and idle: warmer than a shell that is merely alive, quieter
  // than one that is blocked. Finishing is worth noticing and nothing more.
  public static let done = LitBloom(b1: 0.08, b2: 0.035, b3: 0.012, rim: 0.36)
  public static let idle = LitBloom(b1: 0.07, b2: 0.03, b3: 0.01, rim: 0.30)
  public static let none = LitBloom(b1: 0, b2: 0, b3: 0, rim: 0)

  public static func forState(_ state: LitState) -> LitBloom {
    switch state {
    case .working: .working
    case .waiting: .waiting
    case .done: .done
    case .idle: .idle
    case .none: .none
    }
  }
}

/// Pure classification + colour resolution for Aurora's lit chrome.
public enum LitTheme {
  /// Reuses the drawer's own classification so the row and the chrome can never disagree.
  public static func state(for dot: SessionActivityDot?) -> LitState {
    switch dot {
    case .working: .working
    case .waiting: .waiting
    case .done: .done
    case .idle: .idle
    case .stopped, .none: .none
    }
  }

  public static func state(
    status: String?,
    activity: String?,
    lastOutputAt: String?
  ) -> LitState {
    guard let status else { return .none }
    let live = SessionActivityLogic.isRecentlyActive(lastOutputAt: lastOutputAt)
    let dot = SessionActivityLogic.dotKey(status: status, activity: activity, live: live)
    return state(for: dot)
  }

  public static func color(for state: LitState) -> Color {
    switch state {
    case .working: TetherColors.heatWorking
    case .waiting: TetherColors.heatWaiting
    case .done: TetherColors.heatDone
    case .idle: TetherColors.heatCool
    case .none: TetherColors.textFaint
    }
  }

  public static func label(for state: LitState) -> String {
    switch state {
    case .working: "working"
    case .waiting: "waiting"
    case .done: "finished"
    case .idle: "idle"
    case .none: "stopped"
    }
  }
}

/// Runtime chrome tint published through the SwiftUI environment.
public struct LitChrome: Equatable {
  public var state: LitState
  public var color: Color
  public var bloom: LitBloom

  public static let none = LitChrome(
    state: .none,
    color: TetherColors.textFaint,
    bloom: .none
  )

  public static func resolve(
    status: String?,
    activity: String?,
    lastOutputAt: String?
  ) -> LitChrome {
    let state = LitTheme.state(
      status: status,
      activity: activity,
      lastOutputAt: lastOutputAt
    )
    return LitChrome(
      state: state,
      color: LitTheme.color(for: state),
      bloom: LitBloom.forState(state)
    )
  }
}

private struct LitChromeKey: EnvironmentKey {
  static let defaultValue = LitChrome.none
}

extension EnvironmentValues {
  public var litChrome: LitChrome {
    get { self[LitChromeKey.self] }
    set { self[LitChromeKey.self] = newValue }
  }
}
