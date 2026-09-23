import CoreGraphics
import Foundation

/// Pure D-pad geometry and direction lock, testable without a host view.

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
}

public enum DPadModel {
  /// iOS HIG minimum touch target.
  public static let buttonSize: CGFloat = 44
  public static let threshold: CGFloat = 8
  /// Like UIScrollView's directional lock: a short delay so the first noisy pixels do not
  /// pick the wrong axis.
  public static let sampleMs: Int = 100
  public static let repeatDelayMs: Int = 350
  public static let repeatMs: Int = 60
  public static let maxRepeats: Int = 120

  private static let thumbLimit: CGFloat = 11

  /// Locked for the whole gesture so a diagonal drag can't flip axes; returns nil until
  /// `sampled`, so the first pixels of a thumb plant cannot steal the axis.
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
