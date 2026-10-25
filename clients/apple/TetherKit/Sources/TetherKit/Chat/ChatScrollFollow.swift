import CoreGraphics

/// Whether a scroll view is resting at its end, from the geometry the scroll view reports.
enum ChatScrollFollow {
  static let threshold: CGFloat = 48

  /// `offset` is the content offset; at the very end it equals `content + bottomInset - container`.
  static func isNearBottom(
    offset: CGFloat, content: CGFloat, container: CGFloat, bottomInset: CGFloat = 0,
    threshold: CGFloat = threshold
  ) -> Bool {
    let end = content + bottomInset - container
    // Content shorter than the viewport has nothing below it.
    if end <= 0 { return true }
    return end - offset <= threshold
  }
}

/// What the transcript's scroll view reported at one moment.
struct ChatScrollMetrics: Equatable {
  var offset: CGFloat
  var content: CGFloat
  var container: CGFloat

  var isNearBottom: Bool {
    ChatScrollFollow.isNearBottom(offset: offset, content: content, container: container)
  }
}

extension ChatScrollFollow {
  /// An imperative jump to the end, decided once the new layout is known. Content growth while
  /// pinned is the scroll anchor's job; this covers what it does not: the user's own send, once
  /// its rows exist, and a viewport that shrank (keyboard) under a view that was at the end.
  static func shouldJumpToEnd(old: ChatScrollMetrics, new: ChatScrollMetrics, sendPending: Bool) -> Bool {
    if sendPending { return new.content > old.content }
    return old.isNearBottom && new.container != old.container && !new.isNearBottom
  }
}
