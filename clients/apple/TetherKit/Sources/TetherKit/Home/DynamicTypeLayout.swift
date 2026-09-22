import SwiftUI

/// Dynamic Type rules for the app chrome. Nothing here caps text size: at
/// accessibility sizes a row or card keeps what identifies it and
/// drops the supporting details that would push that off screen.
public enum DynamicTypeLayout {
  /// Supporting detail: a session's cwd, a key's randomart.
  public static func showsDetail(for size: DynamicTypeSize) -> Bool {
    !size.isAccessibilitySize
  }

  public static func stacksVertically(for size: DynamicTypeSize) -> Bool {
    size.isAccessibilitySize
  }

  /// The layout that follows `stacksVertically`, so a card cannot disagree with
  /// the predicate it is supposed to obey.
  public static func detailLayout(
    for size: DynamicTypeSize,
    alignment: HorizontalAlignment = .leading,
    stackedSpacing: CGFloat,
    inlineSpacing: CGFloat
  ) -> AnyLayout {
    stacksVertically(for: size)
      ? AnyLayout(VStackLayout(alignment: alignment, spacing: stackedSpacing))
      : AnyLayout(HStackLayout(spacing: inlineSpacing))
  }
}
