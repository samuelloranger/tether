import SwiftUI

/// Motion tokens for the lit chrome. One principle: heat rises fast and cools slowly,
/// so arriving and leaving read as different events. Durations stay short — this sits on a live PTY.
public enum TetherMotion {
  /// Heat arriving: idle → working.
  public static let ignite: Double = 0.26
  /// Heat arriving with a question attached: → waiting.
  public static let arrive: Double = 0.34
  /// Heat leaving: → idle / stopped.
  public static let cool: Double = 0.70
  /// Routine state change (selection, arming, a row becoming active).
  public static let state: Double = 0.20
  /// Immediate acknowledgement of a touch.
  public static let feedback: Double = 0.09
  /// Something covering or uncovering the terminal.
  public static let overlay: Double = 0.28
  /// Reduce Motion still gets a crossfade — Apple's own substitution for
  /// movement — just a short one, with nothing that travels.
  public static let crossfade: Double = 0.12

  /// Confident deceleration. Not a spring: springs overshoot, and an overshoot
  /// on a status colour reads as a second state change.
  public static func decelerate(_ duration: Double) -> Animation {
    .timingCurve(0.16, 1, 0.3, 1, duration: duration)
  }

  /// The animation the chrome uses to reach `state`. Resolved from the destination:
  /// arriving at heat is fast, arriving at cold slow, whichever state you came from.
  public static func heat(to state: LitState, reduceMotion: Bool) -> Animation {
    if reduceMotion { return .easeOut(duration: crossfade) }
    switch state {
    case .working: return decelerate(ignite)
    case .waiting: return decelerate(arrive)
    case .done: return decelerate(arrive)
    case .idle, .none: return .easeOut(duration: cool)
    }
  }

  /// A routine transition, collapsed to a plain crossfade under Reduce Motion.
  public static func ui(_ duration: Double, reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeOut(duration: crossfade) : decelerate(duration)
  }

  /// Fire the one authored swell only on entering `waiting` (never a re-report, never
  /// under Reduce Motion). `settled` keeps launch quiet: a session already waiting at open isn't news.
  public static func pulses(
    from old: LitState,
    to new: LitState,
    settled: Bool,
    reduceMotion: Bool
  ) -> Bool {
    settled && !reduceMotion && new == .waiting && old != .waiting
  }

  /// How fast a swell interrupted by the session moving on gets out of the way.
  /// Short: the chrome underneath has already changed colour.
  public static let pulseCancel: Double = 0.2

  /// Swell up, then let go. Up is faster than down for the same reason ignite
  /// is faster than cool.
  public static let pulseRise: Double = 0.18
  public static let pulseFall: Double = 0.55
}

extension LitBloom {
  /// How much brighter the bloom goes at the swell's peak. The gradient is built at this
  /// gain and sits at `restOpacity` otherwise — SwiftUI animates layer opacity, not gradient colours.
  public static let pulseGain: Double = 1.6
  public static var restOpacity: Double { 1 / pulseGain }
}
