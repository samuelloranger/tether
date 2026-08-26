import CoreGraphics
import Foundation

/// Pure touch→row conversion — port of `apps/mobile/src/terminalTouchScroll.ts`.
public enum TouchScrollModel {
  public struct Result: Equatable, Sendable {
    public var lines: Int
    public var remainder: CGFloat

    public init(lines: Int, remainder: CGFloat) {
      self.lines = lines
      self.remainder = remainder
    }
  }

  /// Accumulates pixel deltas into whole terminal rows without dropping the
  /// fractional remainder between move events.
  public static func lines(
    deltaPixels: CGFloat,
    remainder: CGFloat,
    rowHeight: CGFloat
  ) -> Result {
    guard rowHeight.isFinite, rowHeight > 0 else {
      return Result(lines: 0, remainder: remainder)
    }
    let pixels = deltaPixels + remainder
    let count = Int(pixels / rowHeight)
    return Result(lines: count, remainder: pixels - CGFloat(count) * rowHeight)
  }
}
