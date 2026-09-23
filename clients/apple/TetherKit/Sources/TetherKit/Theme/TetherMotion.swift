import SwiftUI

/// Motion tokens. Durations stay short — this sits on a live PTY.
public enum TetherMotion {
  /// Heat arriving with a question attached: → waiting.
  public static let arrive: Double = 0.34
  /// Routine state change (selection, arming, a row becoming active).
  public static let state: Double = 0.20
  /// Immediate acknowledgement of a touch.
  public static let feedback: Double = 0.09
  /// Something covering or uncovering the terminal.
  public static let overlay: Double = 0.28
  /// A screen arrives from just inside its final size. Kept deliberately small:
  /// the terminal must feel immediate, not theatrical.
  public static let screenEntryScale: CGFloat = 0.965
  /// Physical acknowledgement for tappable chrome.
  public static let pressScale: CGFloat = 0.96
  /// Reduce Motion still gets a crossfade — Apple's own substitution for
  /// movement — just a short one, with nothing that travels.
  public static let crossfade: Double = 0.12
  /// Confident deceleration. Not a spring: springs overshoot, and an overshoot
  /// on a status colour reads as a second state change.
  public static func decelerate(_ duration: Double) -> Animation {
    .timingCurve(0.16, 1, 0.3, 1, duration: duration)
  }

  /// A spring, unlike the rest of the chrome: after a drag an overshoot reads as momentum,
  /// not as a second state change.
  public static func drawerSettle(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeOut(duration: crossfade) : .snappy(duration: 0.3, extraBounce: 0.04)
  }

  /// SwiftUI's default insertion is a fade; opening from the button must slide like the drag does.
  public static func drawerTransition(reduceMotion: Bool) -> AnyTransition {
    reduceMotion ? .opacity : .move(edge: .leading)
  }

  /// A routine transition, collapsed to a plain crossfade under Reduce Motion.
  public static func ui(_ duration: Double, reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeOut(duration: crossfade) : decelerate(duration)
  }

  /// A layered screen change that gives Home and the terminal a sense of depth
  /// without translating the entire view tree (which is fragile around UIKit).
  public static func screenTransition(reduceMotion: Bool) -> AnyTransition {
    reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: screenEntryScale))
  }

}

/// Shared tactile response for cards and chrome. Terminal keys keep their
/// specialised style, while ordinary controls gain the same physical language.
public struct TetherPressStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed && !reduceMotion ? TetherMotion.pressScale : 1)
      .opacity(configuration.isPressed ? 0.9 : 1)
      .animation(TetherMotion.ui(TetherMotion.feedback, reduceMotion: reduceMotion), value: configuration.isPressed)
  }
}
