import Foundation

/// Terminal grid value types shared by the engine and the renderer.
public enum GridSnapshot {
  public static let attrBold: UInt32 = 1 << 0
  public static let attrItalic: UInt32 = 1 << 1
  public static let attrUnderline: UInt32 = 1 << 2
  public static let attrInverse: UInt32 = 1 << 3
  public static let attrDim: UInt32 = 1 << 4
  public static let attrStrikethrough: UInt32 = 1 << 5

  public struct Header: Equatable, Sendable {
    public var cols: UInt16
    public var rows: UInt16
    public var cursorCol: UInt16
    public var cursorRow: UInt16
    public var generation: UInt64
    public var cursorVisible: Bool
    public var altScreen: Bool = false
  }

  public struct Cell: Equatable, Sendable {
    public var codepoint: UInt32
    public var foreground: UInt32
    public var background: UInt32
    public var attrs: UInt32
  }
}

/// The visible grid handed to the renderer.
public struct TerminalFrame: Sendable, Equatable {
  public var header: GridSnapshot.Header
  public var cells: [GridSnapshot.Cell]

  public init(header: GridSnapshot.Header, cells: [GridSnapshot.Cell]) {
    self.header = header
    self.cells = cells
  }
}
