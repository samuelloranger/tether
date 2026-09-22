import SwiftUI

/// Dynamic Type rules for a session row. Nothing here caps text size: at
/// accessibility sizes the row keeps what identifies a session (its name and
/// whether it is the attached one) and drops the two supporting details.
public enum SessionRowLayout {
  /// The working directory and the client count.
  public static func showsDetail(for size: DynamicTypeSize) -> Bool {
    !size.isAccessibilitySize
  }

  public static func stacksVertically(for size: DynamicTypeSize) -> Bool {
    size.isAccessibilitySize
  }
}
