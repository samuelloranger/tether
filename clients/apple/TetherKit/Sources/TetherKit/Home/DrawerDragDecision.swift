import CoreGraphics

/// What a drag over the terminal chrome means for the session drawer.
///
/// Pure so the rules can be proven without a gesture recognizer, and so the
/// terminal surface never has to host one to be tested.
public enum DrawerDragDecision: Equatable {
  case open
  case close
  case ignore

  /// Width of the leading strip that opens the drawer. Narrow on purpose: the
  /// rest of the screen belongs to terminal selection, scrolling, and mouse mode.
  public static let edgeWidth: CGFloat = TetherMotion.drawerEdgeWidth
  /// Below this the drag is touch noise, not a request to move the drawer.
  public static let activationDistance: CGFloat = TetherMotion.drawerActivationDistance

  public static func decide(isOpen: Bool, startX: CGFloat, translation: CGSize) -> DrawerDragDecision {
    // Terminal scrolling starts at the edge too, so direction decides first.
    guard abs(translation.width) > abs(translation.height) else { return .ignore }
    if isOpen {
      return translation.width <= -activationDistance ? .close : .ignore
    }
    guard startX <= edgeWidth else { return .ignore }
    return translation.width >= activationDistance ? .open : .ignore
  }
}
