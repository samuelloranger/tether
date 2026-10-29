import SwiftUI

extension ToolbarContent {
  /// iOS 26 wraps every toolbar item in a glass bubble; the chat screens stay flat.
  @ToolbarContentBuilder func withoutGlass() -> some ToolbarContent {
    if #available(iOS 26.0, *) { sharedBackgroundVisibility(.hidden) } else { self }
  }
}
