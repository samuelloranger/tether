#if canImport(UIKit)
import SwiftUI
import UIKit

private let drawerWidth: CGFloat = 264

/// Slide-over session drawer with a dimmed scrim and UIKit edge-pan to open.
public struct SessionDrawerOverlay: View {
  @Binding public var isPresented: Bool
  public var store: SessionStore
  public var onSelectSession: (String, String) -> Void
  public var onReenterPassword: (String) -> Void
  public var onHostSettings: (String) -> Void

  public init(
    isPresented: Binding<Bool>,
    store: SessionStore,
    onSelectSession: @escaping (String, String) -> Void,
    onReenterPassword: @escaping (String) -> Void,
    onHostSettings: @escaping (String) -> Void
  ) {
    _isPresented = isPresented
    self.store = store
    self.onSelectSession = onSelectSession
    self.onReenterPassword = onReenterPassword
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
          onReenterPassword: { hostId in
            dismiss()
            onReenterPassword(hostId)
          },
          onHostSettings: { hostId in
            dismiss()
            onHostSettings(hostId)
          },
          onClose: dismiss
        )
        .frame(width: drawerWidth)
        .frame(maxHeight: .infinity)
        .transition(.move(edge: .leading))
      }

      LeadingEdgeSwipeHandle(onSwipe: open)
        .frame(width: 20)
        .frame(maxHeight: .infinity, alignment: .leading)
    }
    .animation(.easeOut(duration: 0.22), value: isPresented)
  }

  private func open() {
    Task {
      await store.refreshDrawer()
      isPresented = true
    }
  }

  private func dismiss() {
    isPresented = false
  }
}

private struct LeadingEdgeSwipeHandle: UIViewRepresentable {
  var onSwipe: () -> Void

  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    view.backgroundColor = .clear
    let recognizer = UIScreenEdgePanGestureRecognizer(
      target: context.coordinator,
      action: #selector(Coordinator.handleSwipe(_:))
    )
    recognizer.edges = .left
    view.addGestureRecognizer(recognizer)
    return view
  }

  func updateUIView(_ uiView: UIView, context: Context) {
    context.coordinator.onSwipe = onSwipe
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(onSwipe: onSwipe)
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
