import SwiftUI

/// Dynamic Type rules for the app chrome. Nothing here caps text size: at
/// accessibility sizes a row or card keeps what identifies it and
/// drops the supporting details that would push that off screen.
public enum DynamicTypeLayout {
  /// Supporting detail: a session's cwd and client count, a key's randomart.
  public static func showsDetail(for size: DynamicTypeSize) -> Bool {
    !size.isAccessibilitySize
  }

  public static func stacksVertically(for size: DynamicTypeSize) -> Bool {
    size.isAccessibilitySize
  }
}
