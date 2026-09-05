#if canImport(UIKit)
import SwiftUI
import UIKit

private let drawerWidth: CGFloat = 264

/// Slide-over session drawer with a dimmed scrim and UIKit edge-pan to open.
public struct SessionDrawerOverlay: View {
  @Binding public var isPresented: Bool
  public var store: SessionStore
  public var onSelectSession: (String, String) -> Void
  public var onHostSettings: (String) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(
    isPresented: Binding<Bool>,
    store: SessionStore,
    onSelectSession: @escaping (String, String) -> Void,
    onHostSettings: @escaping (String) -> Void
  ) {
    _isPresented = isPresented
    self.store = store
    self.onSelectSession = onSelectSession
    self.onHostSettings = onHostSettings
  }

  public var body: some View {
    ZStack(alignment: .leading) {
      if isPresented {
        Color.black.opacity(0.35)
          .ignoresSafeArea()
          .onTapGesture { dismiss() }
          .transition(.opacity)

        SessionDrawerView(
          store: store,
          onSelectSession: { hostId, sessionId in
            onSelectSession(hostId, sessionId)
            dismiss()
          },
          onHostSettings: { hostId in
            dismiss()
            onHostSettings(hostId)
          },
          onClose: dismiss
        )
        .frame(width: drawerWidth)
        .frame(maxHeight: .infinity)
        // The drawer comes from the edge it lives on, so the gesture that opens
        // it and the animation that answers are the same movement. Reduce
        // Motion gets the crossfade instead — the panel is 264pt of travel,
        // which is exactly the kind of slide that setting is asking about.
        .transition(reduceMotion ? .opacity : .move(edge: .leading))
      }

      LeadingEdgeSwipeHandle(onSwipe: open)
        .frame(width: 20)
        .frame(maxHeight: .infinity, alignment: .leading)
    }
    // Without this the ZStack shrinks to its only child when the drawer is
    // closed — a 20pt column — and the parent ZStack centres it, putting an
    // invisible touch-swallowing strip down the middle of the terminal and
    // leaving the edge recogniser nowhere near the edge.
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    // Exits faster than it enters: dismissing is a decision already made, and
    // waiting for the panel to leave is waiting for the terminal to come back.
    .animation(
      TetherMotion.ui(isPresented ? TetherMotion.overlay : TetherMotion.state, reduceMotion: reduceMotion),
      value: isPresented
    )
  }

  private func open() {
    // Same reason as RootView.openDrawer: never gate the panel on the network.
    isPresented = true
    store.refreshDrawerInBackground()
  }

  private func dismiss() {
    isPresented = false
  }
}

private struct LeadingEdgeSwipeHandle: UIViewRepresentable {
  var onSwipe: () -> Void

  func makeUIView(context: Context) -> EdgeHandleView {
    let view = EdgeHandleView()
    view.backgroundColor = .clear
    let recognizer = UIScreenEdgePanGestureRecognizer(
      target: context.coordinator,
      action: #selector(Coordinator.handleSwipe(_:))
    )
    recognizer.edges = .left
    view.addGestureRecognizer(recognizer)
    return view
  }

  func updateUIView(_ uiView: EdgeHandleView, context: Context) {
    context.coordinator.onSwipe = onSwipe
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(onSwipe: onSwipe)
  }

  /// Claims a touch only when it starts within the screen-edge band the
  /// recogniser can actually act on. A plain UIView would swallow every touch
  /// inside its bounds and never hand it back to the terminal underneath.
  final class EdgeHandleView: UIView {
    static let edgeBand: CGFloat = 20

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
      guard super.point(inside: point, with: event) else { return false }
      let originX = convert(CGPoint.zero, to: window).x
      return originX + point.x <= Self.edgeBand
    }
  }

  final class Coordinator: NSObject {
    var onSwipe: () -> Void

    init(onSwipe: @escaping () -> Void) {
      self.onSwipe = onSwipe
    }

    @objc func handleSwipe(_ recognizer: UIScreenEdgePanGestureRecognizer) {
      guard recognizer.state == .recognized else { return }
      onSwipe()
    }
  }
}
#endif
