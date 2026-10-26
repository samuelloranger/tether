/// The recent slice of the transcript that is laid out. Rows are exact-height views in a plain stack,
/// so the end of the scroll view is real, not an estimate over rows that were never realised.
/// The window starts at a block id, so it only grows: new blocks join the end, and "Earlier
/// messages" moves the start back.
enum ChatTranscriptWindow {
  static let pageSize = 60

  /// `lastIDs` is each block's last item id, in order; `start` is the id the window begins at.
  static func range(lastIDs: [Int], start: Int?) -> Range<Int> {
    guard let start, let first = lastIDs.firstIndex(where: { $0 >= start }) else {
      return max(0, lastIDs.count - pageSize)..<lastIDs.count
    }
    return first..<lastIDs.count
  }

  /// Where the window starts once it has been asked for `pageSize` more blocks.
  static func earlierStart(lastIDs: [Int], range: Range<Int>) -> Int? {
    guard range.lowerBound > 0 else { return nil }
    return lastIDs[max(0, range.lowerBound - pageSize)]
  }
}
