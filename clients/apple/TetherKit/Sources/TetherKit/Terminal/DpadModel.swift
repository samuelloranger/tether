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

  /// Signed travel along `direction`; positive means further that way.
  static func travel(_ point: CGPoint, along direction: DPadDirection) -> CGFloat {
    switch direction {
    case .C: point.x
    case .D: -point.x
    case .B: point.y
    case .A: -point.y
    }
  }

  static func unit(_ direction: DPadDirection) -> CGPoint {
    switch direction {
    case .C: CGPoint(x: 1, y: 0)
    case .D: CGPoint(x: -1, y: 0)
    case .B: CGPoint(x: 0, y: 1)
    case .A: CGPoint(x: 0, y: -1)
    }
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

/// One gesture's direction lock. The neutral point ratchets to the finger's furthest travel in
/// the locked direction, so backing off releases the lock and keeps going into the opposite
/// arrow — the finger never has to return to where it landed.
public struct DPadLock: Sendable {
  public private(set) var direction: DPadDirection?
  private var origin: CGPoint = .zero
  private var peak: CGFloat = 0

  public init() {}

  /// `translation` is the raw drag translation since touch-down.
  public mutating func update(translation: CGPoint, sampled: Bool) -> DPadDirection? {
    if let direction {
      let travel = DPadModel.travel(translation, along: direction)
      peak = max(peak, travel)
      if peak - travel < DPadModel.threshold { return direction }
      // Re-centre just inside the neutral band: a further `threshold` back picks the opposite
      // arrow, a return to the peak resumes the old one. The perpendicular drift is dropped so
      // it can't vote for a new axis.
      let ahead = peak - DPadModel.threshold - travel
      let unit = DPadModel.unit(direction)
      origin = CGPoint(x: translation.x + unit.x * ahead, y: translation.y + unit.y * ahead)
      self.direction = nil
    }
    let r = relative(translation)
    direction = DPadModel.resolveDirection(dx: r.x, dy: r.y, active: nil, sampled: sampled)
    if let direction { peak = DPadModel.travel(translation, along: direction) }
    return direction
  }

  /// Translation measured from the current neutral point.
  public func relative(_ translation: CGPoint) -> CGPoint {
    CGPoint(x: translation.x - origin.x, y: translation.y - origin.y)
  }
}
