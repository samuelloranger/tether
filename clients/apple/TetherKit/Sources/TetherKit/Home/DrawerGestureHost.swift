import SwiftUI
import UIKit

/// UIKit recognizers, not `DragGesture`: SwiftUI has no cancelled state, so a touch
/// claimed mid-drag never ran `onEnded` and stranded the panel partly open.
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

    /// The terminal's pan begins the moment a finger moves, so ours must go first;
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
