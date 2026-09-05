#if canImport(UIKit)
import SwiftUI
import UIKit

/// Terminal D-pad: one bar key, drag for a locked cardinal + capped auto-repeat.
/// Position is owned by the parent so the pad can be dragged around the surface.
public struct DpadView: View {
  public var size: CGFloat
  public var onArrow: (DPadDirection) -> Void

  @State private var thumb = CGSize.zero
  @State private var active: DPadDirection?
  @State private var grantOrigin = CGPoint.zero
  @State private var gestureLive = false
  @State private var repeatTask: Task<Void, Never>?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let feedback = UIImpactFeedbackGenerator(style: .light)

  public init(size: CGFloat = DPadModel.buttonSize, onArrow: @escaping (DPadDirection) -> Void) {
    self.size = size
    self.onArrow = onArrow
  }

  public var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 8)
        .fill(TetherColors.surfaceRaised)
      glyph
    }
    .frame(width: size, height: size)
    .contentShape(Rectangle())
    .gesture(padGesture)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Terminal arrow keys")
    .accessibilityHint("Drag in a direction and hold to repeat")
    .accessibilityAction(named: Text("Up")) { onArrow(.A) }
    .accessibilityAction(named: Text("Down")) { onArrow(.B) }
    .accessibilityAction(named: Text("Left")) { onArrow(.D) }
    .accessibilityAction(named: Text("Right")) { onArrow(.C) }
    .onDisappear { stopRepeat() }
  }

  private var glyph: some View {
    ZStack {
      Image(systemName: "arrowtriangle.up.fill")
        .offset(y: -10)
      Image(systemName: "arrowtriangle.down.fill")
        .offset(y: 10)
      Image(systemName: "arrowtriangle.left.fill")
        .offset(x: -10)
      Image(systemName: "arrowtriangle.right.fill")
        .offset(x: 10)
    }
    .font(.system(size: 11, weight: .bold))
    .foregroundStyle(TetherColors.textPrimary)
    .offset(thumb)
    .allowsHitTesting(false)
  }

  private var padGesture: some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { value in
        if !gestureLive {
          gestureLive = true
          grantOrigin = DPadModel.grantOffset(
            locationX: value.startLocation.x,
            locationY: value.startLocation.y,
            size: size
          )
        }
        let x = grantOrigin.x + value.translation.width
        let y = grantOrigin.y + value.translation.height
        let next = DPadModel.resolveDirection(dx: x, dy: y, active: active)
        let offset = DPadModel.thumbOffset(dx: x, dy: y, direction: next)
        thumb = CGSize(width: offset.x, height: offset.y)
        activate(next)
      }
      .onEnded { _ in
        finish()
      }
  }

  private func activate(_ next: DPadDirection?) {
    if next == active { return }
    stopRepeat()
    active = next
    guard let next else { return }
    // The RN cluster taps a light impact per arrow — without it a drag that
    // locks a new direction gives no signal that anything was sent.
    Self.feedback.impactOccurred()
    onArrow(next)
    repeatTask = Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(DPadModel.repeatDelayMs))
      guard !Task.isCancelled else { return }
      var sent = 0
      while !Task.isCancelled, sent < DPadModel.maxRepeats {
        guard let active else { break }
        onArrow(active)
        sent += 1
        try? await Task.sleep(for: .milliseconds(DPadModel.repeatMs))
      }
    }
  }

  private func finish() {
    stopRepeat()
    active = nil
    grantOrigin = .zero
    gestureLive = false
    // Springs back to centre — the glyph is a physical thing the finger let go of.
    // Reduce Motion returns it without the travel.
    withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.7)) {
      thumb = .zero
    }
  }

  private func stopRepeat() {
    repeatTask?.cancel()
    repeatTask = nil
  }
}
#endif
