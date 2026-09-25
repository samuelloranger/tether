import CoreGraphics
import SwiftTerm

/// How the cursor is drawn: the user's setting, or a shape a program asked for with DECSCUSR.
public struct TerminalCursorStyle: Equatable, Sendable {
  public enum Shape: String, CaseIterable, Identifiable, Sendable {
    case block
    case bar
    case underline

    public var id: String { rawValue }

    public var label: String {
      switch self {
      case .block: "Block"
      case .bar: "Bar"
      case .underline: "Underline"
      }
    }
  }

  public var shape: Shape
  public var blink: Bool

  public init(shape: Shape, blink: Bool) {
    self.shape = shape
    self.blink = blink
  }

  public static let `default` = TerminalCursorStyle(shape: .block, blink: false)

  /// Bar and underline thickness, in points.
  static let lineThickness: CGFloat = 2

  /// Where the cursor sits inside the cell it is on.
  func frame(inCell cell: CGRect) -> CGRect {
    switch shape {
    case .block:
      return cell
    case .bar:
      return CGRect(x: cell.minX, y: cell.minY, width: min(Self.lineThickness, cell.width), height: cell.height)
    case .underline:
      let height = min(Self.lineThickness, cell.height)
      return CGRect(x: cell.minX, y: cell.maxY - height, width: cell.width, height: height)
    }
  }
}

extension TerminalCursorStyle {
  /// SwiftTerm's startup style, which DECSCUSR 0 also returns to. Read as "no program
  /// request", so the user's setting shows; a program asking for blinking block (1)
  /// explicitly can't be told apart from that.
  static let engineDefault: CursorStyle = .blinkBlock

  /// Nil when the terminal is at its startup style.
  init?(program style: CursorStyle) {
    guard style != Self.engineDefault else { return nil }
    switch style {
    case .blinkBlock: self.init(shape: .block, blink: true)
    case .steadyBlock: self.init(shape: .block, blink: false)
    case .blinkUnderline: self.init(shape: .underline, blink: true)
    case .steadyUnderline: self.init(shape: .underline, blink: false)
    case .blinkBar: self.init(shape: .bar, blink: true)
    case .steadyBar: self.init(shape: .bar, blink: false)
    }
  }

  /// The DECSCUSR parameter that selects this style.
  var decscusrParameter: Int {
    switch shape {
    case .block: blink ? 1 : 2
    case .underline: blink ? 3 : 4
    case .bar: blink ? 5 : 6
    }
  }
}
