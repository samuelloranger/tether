import SwiftUI
import UIKit

/// The drawer's gestures, as UIKit recognizers on the window.
///
/// SwiftUI's `DragGesture` has no cancelled state: when another recognizer
/// claimed the touch mid-drag, `onEnded` never ran and the panel stayed
/// stranded a few points open. `UIScreenEdgePanGestureRecognizer` is what the
/// system uses for an edge drawer, and it reports cancellation.
struct DrawerGestureHost: UIViewRepresentable {
  /// Read when a gesture starts, not when this view is built.
  var isOpen: () -> Bool
  var onBegan: () -> Void
  var onChanged: (CGFloat) -> Void
  var onEnded: (CGFloat, CGFloat) -> Void
  var onCancelled: () -> Void

  func makeUIView(context: Context) -> UIView {
    let view = PassthroughView()
    view.onMoveToWindow = { [weak coordinator = context.coordinator] window in
      coordinator?.attach(to: window)
    }
    return view
  }

  func updateUIView(_ uiView: UIView, context: Context) {
    context.coordinator.host = self
  }

  func makeCoordinator() -> Coordinator { Coordinator(host: self) }

  static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
    coordinator.detach()
  }

  /// Exists only to reach the window; never takes a touch itself.
  private final class PassthroughView: UIView {
    var onMoveToWindow: ((UIWindow?) -> Void)?

    override func didMoveToWindow() {
      super.didMoveToWindow()
      onMoveToWindow?(window)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var host: DrawerGestureHost
    private weak var window: UIWindow?
    private var edgePan: UIScreenEdgePanGestureRecognizer?
    private var closePan: UIPanGestureRecognizer?

    init(host: DrawerGestureHost) {
      self.host = host
    }

    func attach(to window: UIWindow?) {
      guard self.window !== window else { return }
      detach()
      guard let window else { return }
      self.window = window

      let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handle))
      edge.edges = .left
      edge.delegate = self
      window.addGestureRecognizer(edge)
      edgePan = edge

      let close = UIPanGestureRecognizer(target: self, action: #selector(handle))
      close.delegate = self
      window.addGestureRecognizer(close)
      closePan = close
    }

    func detach() {
      if let edgePan { window?.removeGestureRecognizer(edgePan) }
      if let closePan { window?.removeGestureRecognizer(closePan) }
      edgePan = nil
      closePan = nil
      window = nil
    }

    @objc private func handle(_ recognizer: UIPanGestureRecognizer) {
      let translation = recognizer.translation(in: recognizer.view).x
      switch recognizer.state {
      case .began:
        host.onBegan()
        host.onChanged(translation)
      case .changed:
        host.onChanged(translation)
      case .ended:
        host.onEnded(translation, recognizer.velocity(in: recognizer.view).x)
      // The case SwiftUI could not express.
      case .cancelled, .failed:
        host.onCancelled()
      default:
        break
      }
    }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
      if recognizer === edgePan { return !host.isOpen() }
      guard recognizer === closePan, host.isOpen() else { return false }
      guard let pan = closePan else { return false }
      let velocity = pan.velocity(in: pan.view)
      guard DrawerDragDecision.panBelongsToDrawer(
        velocity: CGSize(width: velocity.x, height: velocity.y)
      ) else { return false }
      return true
    }

    func gestureRecognizer(
      _ recognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
      false
    }

    /// The terminal's own pan begins the moment a finger moves and used to win
    /// every race, so the edge swipe did nothing over the grid. Ours goes first;
    /// the instant it fails the terminal gets the touch untouched.
    func gestureRecognizer(
      _ recognizer: UIGestureRecognizer,
      shouldBeRequiredToFailBy other: UIGestureRecognizer
    ) -> Bool {
      // The close pan only earns that priority while the drawer is open, or it
      // would sit in Possible through every terminal touch.
      if recognizer === edgePan { return true }
      return recognizer === closePan && host.isOpen()
    }
  }
}
