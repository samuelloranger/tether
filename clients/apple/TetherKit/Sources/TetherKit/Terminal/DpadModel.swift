import CoreGraphics
import Foundation

/// Pure D-pad geometry and direction lock — port of `apps/mobile/src/dpadModel.ts`.
/// No SwiftUI; keep behaviour testable without a host view.

public enum DPadDirection: String, Sendable, CaseIterable {
  /// Up — CSI `A`
  case A
  /// Down — CSI `B`
  case B
  /// Right — CSI `C`
  case C
  /// Left — CSI `D`
  case D

  public var escapeSequence: String {
    switch self {
    case .A: "\u{1B}[A"
    case .B: "\u{1B}[B"
    case .C: "\u{1B}[C"
    case .D: "\u{1B}[D"
    }
  }

  public var accessibilityLabel: String {
    switch self {
    case .A: "Up"
    case .B: "Down"
    case .C: "Right"
    case .D: "Left"
    }
  }
}

public enum DPadModel {
  /// iOS HIG floor — matches `MIN_TOUCH_TARGET` on mobile.
  public static let buttonSize: CGFloat = 44
  public static let threshold: CGFloat = 8
  /// Wait this long, then lock to the axis of the accumulated translation.
  /// UIScrollView's directional lock does the same: a short delay so the first
  /// noisy pixels do not pick vertical when the drag is horizontal (and vice versa).
  public static let sampleMs: Int = 100
  public static let repeatDelayMs: Int = 350
  public static let repeatMs: Int = 60
  public static let maxRepeats: Int = 120

  private static let thumbLimit: CGFloat = 11

  /// Direction is locked for the whole gesture once picked — a diagonal drag
  /// must not flip between axes mid-hold. Re-resolving only happens once the
  /// finger returns inside the center threshold.
  ///
  /// `sampled` is false until `sampleMs` of finger movement have been measured
  /// (or the finger lifts). Until then this returns nil so the first 8 px of a
  /// thumb plant cannot steal the axis.
  public static func resolveDirection(
    dx: CGFloat,
    dy: CGFloat,
    active: DPadDirection?,
    sampled: Bool
  ) -> DPadDirection? {
    let horizontal = abs(dx)
    let vertical = abs(dy)
    if max(horizontal, vertical) < threshold { return nil }
    if let active { return active }
    if !sampled { return nil }

    if horizontal >= vertical {
      return dx >= 0 ? .C : .D
    }
    return dy >= 0 ? .B : .A
  }

  /// Touch location inside the puck as an offset from its center.
  ///
  /// `size` is passed in rather than read from `buttonSize`: the bar renders the
  /// pad at the same height as its text keys, and a center computed from a
  /// different size biases every drag by the difference.
  public static func grantOffset(
    locationX: CGFloat,
    locationY: CGFloat,
    size: CGFloat = buttonSize
  ) -> CGPoint {
    let center = size / 2
    return CGPoint(x: locationX - center, y: locationY - center)
  }

  /// Icon rides the locked cardinal only — never free-slides diagonally.
  public static func thumbOffset(
    dx: CGFloat,
    dy: CGFloat,
    direction: DPadDirection?
  ) -> CGPoint {
    guard let direction else { return .zero }
    let travel = min(thumbLimit, (dx * dx + dy * dy).squareRoot().rounded())
    switch direction {
    case .C: return CGPoint(x: travel, y: 0)
    case .D: return CGPoint(x: -travel, y: 0)
    case .B: return CGPoint(x: 0, y: travel)
    case .A: return CGPoint(x: 0, y: -travel)
    }
  }
}
