import CoreGraphics
import Foundation

/// Mouse report encoding — port of `apps/mobile/src/mouseSeq.ts` + `mouseInput.ts`.

public enum MouseMode: String, Sendable, Equatable {
  case off
  case x10
  case normal
  case button
  case any
}

public enum MouseSeq {
  public static func encode(
    btn: Int,
    col: Int,
    row: Int,
    sgr: Bool,
    release: Bool = false,
    motion: Bool = false
  ) -> String {
    let motionBit = motion ? 32 : 0
    if sgr {
      let cb = btn + motionBit
      return "\u{1B}[<\(cb);\(col);\(row)\(release ? "m" : "M")"
    }
    let cb = (release ? (btn & ~0b11) | 0b11 : btn) + motionBit
    func enc(_ n: Int) -> String {
      String(UnicodeScalar(UInt8(clamping: min(127, max(0, n + 32)))))
    }
    return "\u{1B}[M\(enc(cb))\(enc(col))\(enc(row))"
  }

  public static func cellFromPoint(
    x: CGFloat,
    y: CGFloat,
    bounds: CGRect,
    cols: Int,
    rows: Int,
    cellWidth: CGFloat,
    cellHeight: CGFloat
  ) -> (col: Int, row: Int) {
    let col = min(cols, max(1, Int(floor((x - bounds.minX) / max(cellWidth, 1))) + 1))
    let row = min(rows, max(1, Int(floor((y - bounds.minY) / max(cellHeight, 1))) + 1))
    return (col, row)
  }

  public static func pressSeq(col: Int, row: Int, sgr: Bool, btn: Int = 0, mods: Int = 0) -> String {
    encode(btn: btn + mods, col: col, row: row, sgr: sgr)
  }

  public static func releaseSeq(
    col: Int,
    row: Int,
    mode: MouseMode,
    sgr: Bool,
    btn: Int = 0,
    mods: Int = 0
  ) -> String? {
    if mode == .x10 { return nil }
    return encode(btn: btn + mods, col: col, row: row, sgr: sgr, release: true)
  }

  public static func motionSeq(
    col: Int,
    row: Int,
    mode: MouseMode,
    sgr: Bool,
    btn: Int = 0,
    mods: Int = 0
  ) -> String? {
    if mode != .button, mode != .any { return nil }
    return encode(btn: btn + mods, col: col, row: row, sgr: sgr, motion: true)
  }

  public static func clickSeqs(
    col: Int,
    row: Int,
    mode: MouseMode,
    sgr: Bool,
    btn: Int = 0,
    mods: Int = 0
  ) -> [String] {
    var seqs = [pressSeq(col: col, row: row, sgr: sgr, btn: btn, mods: mods)]
    if let rel = releaseSeq(col: col, row: row, mode: mode, sgr: sgr, btn: btn, mods: mods) {
      seqs.append(rel)
    }
    return seqs
  }

  /// Wheel button codes: 64 = up, 65 = down (SGR / X10 high bits).
  public static func wheelSeq(up: Bool, col: Int, row: Int, sgr: Bool) -> String {
    encode(btn: up ? 64 : 65, col: col, row: row, sgr: sgr)
  }
}
