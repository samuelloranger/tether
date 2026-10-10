/// Decodes a byte stream that arrives in arbitrary chunks: a character split across two reads
/// is held until its last byte arrives, instead of turning into U+FFFD on both sides.
struct UTF8StreamDecoder {
  private var pending: [UInt8] = []

  mutating func decode(_ chunk: some Sequence<UInt8>) -> String {
    var bytes = pending + chunk
    let keep = Self.incompleteTail(bytes)
    pending = Array(bytes.suffix(keep))
    bytes.removeLast(keep)
    return String(decoding: bytes, as: UTF8.self)
  }

  /// How many trailing bytes begin a sequence whose remaining bytes have not arrived yet.
  static func incompleteTail(_ bytes: [UInt8]) -> Int {
    var index = bytes.count - 1
    while index >= 0, bytes.count - index <= 4 {
      let byte = bytes[index]
      if byte & 0xC0 == 0x80 {
        index -= 1
        continue
      }
      let needed = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : byte >= 0xC0 ? 2 : 1
      let have = bytes.count - index
      return have < needed ? have : 0
    }
    return 0
  }
}
