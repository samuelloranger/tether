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

  /// How far past fully open the panel may be pushed, as a fraction of its
  /// width. Enough to feel like the finger is heard, not enough to look loose.
  private static let overshootResistance: Double = 0.06

  /// Where the panel sits for a drag in progress: 0 closed, 1 open. A live drag
  /// is a position, not a verdict — this is what makes the panel track the
  /// finger instead of playing an animation when the finger lifts.
  public static func progress(isOpen: Bool, translationX: CGFloat, width: CGFloat) -> Double {
    guard width > 0 else { return isOpen ? 1 : 0 }
    let raw = (isOpen ? 1 : 0) + Double(translationX / width)
    if raw <= 0 { return 0 }
    guard raw > 1 else { return raw }
    // Past fully open the panel keeps moving, but a fraction as far.
    return 1 + (raw - 1) * overshootResistance
  }

  /// How far the pan would coast at its release speed. A quarter second is what
  /// a flick reads as: long enough that a fast short swipe carries the panel
  /// home, short enough that a slow drag is decided by where it actually is.
  private static let coastSeconds: CGFloat = 0.25

  /// Where the drag was headed when the finger lifted. `velocityX` is the pan
  /// recognizer's own points-per-second reading, so a short fast flick settles
  /// open while the same distance dragged slowly does not.
  public static func settlesOpen(
    isOpen: Bool, translationX: CGFloat, velocityX: CGFloat, width: CGFloat
  ) -> Bool {
    guard width > 0 else { return isOpen }
    let projected = progress(
      isOpen: isOpen, translationX: translationX + velocityX * coastSeconds, width: width)
    return projected >= 0.5
  }

  /// A pan only belongs to the drawer when it is going sideways. The terminal
  /// scrolls vertically and the drawer's own list scrolls vertically, so a pan
  /// that is mostly up or down is theirs.
  public static func panBelongsToDrawer(velocity: CGSize) -> Bool {
    abs(velocity.width) > abs(velocity.height)
  }

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
