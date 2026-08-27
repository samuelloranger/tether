import SwiftUI

/// Motion tokens for the lit chrome.
///
/// One idea runs through all of them: **heat rises fast and cools slowly**. A
/// session that starts working, or that stops to ask you something, is news —
/// it arrives quickly. A session going quiet is not news, so the chrome lets go
/// of the colour over most of a second instead of snapping to grey. The
/// asymmetry is the whole point; equal durations in both directions would make
/// the two events read as the same event.
///
/// Durations are deliberately short everywhere else. This is an Operate
/// surface sitting on top of a live PTY: motion here acknowledges an action or
/// explains a state change, and anything longer than the change it describes
/// reads as latency.
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

  /// The animation the chrome uses to reach `state`.
  ///
  /// Resolved from the destination rather than the transition, because SwiftUI
  /// reads `.animation(_:value:)` against the new value — and because the
  /// destination is what the duration is about: arriving at heat is fast,
  /// arriving at cold is slow, whichever state you came from.
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

  /// Whether the chrome should fire its one authored moment: the single,
  /// non-repeating swell when a session stops and asks for input.
  ///
  /// Only on *entering* waiting, so a drawer refresh that re-reports the same
  /// state cannot pulse again, and never under Reduce Motion — a change in
  /// brightness that the user did not cause is exactly what that setting is
  /// asking the app not to do.
  ///
  /// `settled` is what keeps launch quiet. The store has no sessions until the
  /// first fetch answers, so the chrome starts at `none` and every session
  /// arrives as a change — and a session that was already waiting when the app
  /// opened would announce itself as though it had just stopped to ask a
  /// question. Nothing happened; loading finished. The swell waits until the
  /// chrome has shown one live state.
  public static func pulses(
    from old: LitState,
    to new: LitState,
    settled: Bool,
    reduceMotion: Bool
  ) -> Bool {
    settled && !reduceMotion && new == .waiting && old != .waiting
  }

  /// How fast a swell interrupted by the session moving on gets out of the way.
  /// Short: the chrome underneath has already changed colour, and the leftover
  /// brightness belongs to a state that is over.
  public static let pulseCancel: Double = 0.2

  /// Swell up, then let go. Up is faster than down for the same reason ignite
  /// is faster than cool.
  public static let pulseRise: Double = 0.18
  public static let pulseFall: Double = 0.55
}

extension LitBloom {
  /// How much brighter the bloom goes at the peak of the waiting swell.
  ///
  /// The gradient is *built* at this gain and the layer sits at
  /// `restOpacity` when nothing is happening, so at rest it renders exactly the
  /// alphas `LitBloom` documents. This indirection exists because SwiftUI does
  /// not interpolate the colours inside a gradient — layer opacity is the one
  /// handle on a gradient that does animate smoothly.
  public static let pulseGain: Double = 1.6
  public static var restOpacity: Double { 1 / pulseGain }
}
