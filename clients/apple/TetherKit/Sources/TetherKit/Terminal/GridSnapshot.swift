import Foundation

/// Packed terminal grid buffer (TGRD) — must match `crates/tether-ffi/src/grid_snapshot.rs`.
public enum GridSnapshot {
  public static let magic: UInt32 = 0x5447_5244 // "TGRD"
  public static let version: UInt16 = 1
  public static let headerSize = 24
  public static let cellStride = 16

  public static let flagCursorVisible: UInt16 = 1 << 0

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
  }

  public struct Cell: Equatable, Sendable {
    public var codepoint: UInt32
    public var foreground: UInt32
    public var background: UInt32
    public var attrs: UInt32
  }

  public enum DecodeError: Error, Equatable {
    case tooShort
    case badMagic
    case badVersion(UInt16)
    case sizeMismatch(length: Int, cols: UInt16, rows: UInt16)
  }

  public static func bufferSize(cols: UInt16, rows: UInt16) -> Int {
    headerSize + Int(cols) * Int(rows) * cellStride
  }
}
