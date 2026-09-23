import Foundation

enum SSHRandomart {
  private static let width = 17
  private static let height = 9

  static func field(digest: Data) -> [[Int]] {
    var field = [[Int]](repeating: [Int](repeating: 0, count: width), count: height)
    var x = width / 2
    var y = height / 2

    for byte in digest {
      var bits = byte
      for _ in 0..<4 {
        x += (bits & 1) == 1 ? 1 : -1
        y += (bits & 2) == 2 ? 1 : -1
        x = min(max(x, 0), width - 1)
        y = min(max(y, 0), height - 1)
        if field[y][x] < 14 { field[y][x] += 1 }
        bits >>= 2
      }
    }
    field[height / 2][width / 2] = 15 // start
    field[y][x] = 16 // end
    return field
  }
}
