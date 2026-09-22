#if canImport(UIKit)
import SwiftUI
import UIKit

/// The drawer's gestures, as UIKit recognizers on the window.
///
/// SwiftUI's `DragGesture` cannot do this job. It has no cancelled state, so
/// when another recognizer claimed the touch mid-drag the drag simply stopped —
/// `onEnded` never ran and the panel stayed stranded a few points open until a
/// second, harder swipe. It also loses the edge to the terminal surface's own
/// recognizers. `UIScreenEdgePanGestureRecognizer` is what the system itself
/// uses for an edge drawer: it claims the touch at the edge, cancels the
/// recognizers underneath it, and reports began / changed / ended / cancelled.
struct DrawerGestureHost: UIViewRepresentable {
  /// Read when a gesture starts, not when this view is built.
  var isOpen: () -> Bool
  /// Width of the open panel, for the close gesture's start region.
  var panelWidth: () -> CGFloat
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

  /// Never takes a touch itself — it exists only to reach the window.
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
      // The case SwiftUI could not express: the system took the touch back, so
      // put the panel where it was instead of leaving it mid-slide.
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
      // Only from over the panel: a sideways pan on the dimmed terminal is not
      // a drag of something the finger is holding.
      return pan.location(in: pan.view).x <= host.panelWidth()
    }

    /// The panel's list still scrolls: a vertical pan fails this recognizer's
    /// own begin check above, leaving the scroll view's recognizer to it.
    func gestureRecognizer(
      _ recognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
      false
    }

    /// The terminal surface runs its own pan for scrolling, selection and mouse
    /// mode, and it begins the moment a finger moves — so it used to win every
    /// race and the edge swipe did nothing over the grid. Ours goes first: a
    /// pan underneath waits for it, and the instant it fails (a touch that did
    /// not start at the edge, or one that went vertical) the terminal proceeds
    /// with the touch untouched. This is what UIKit does for its own
    /// interactive pop gesture over a scroll view.
    func gestureRecognizer(
      _ recognizer: UIGestureRecognizer,
      shouldBeRequiredToFailBy other: UIGestureRecognizer
    ) -> Bool {
      recognizer === edgePan || recognizer === closePan
    }
  }
}
#endif
