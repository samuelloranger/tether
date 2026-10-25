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
