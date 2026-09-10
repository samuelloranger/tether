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
  @State private var sampleDx: CGFloat = 0
  @State private var sampleDy: CGFloat = 0
  @State private var sampled = false
  @State private var gestureLive = false
  @State private var sampleTask: Task<Void, Never>?
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
    .onDisappear {
      sampleTask?.cancel()
      stopRepeat()
    }
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
          armSample()
        }
        sampleDx = value.translation.width
        sampleDy = value.translation.height
        guard sampled || active != nil else { return }
        applyCurrent()
      }
      .onEnded { _ in
        commitIfNeeded()
        finish()
      }
  }

  /// Finger translation only — where the thumb landed on the puck is not a vote.
  private func applyCurrent() {
    let next = DPadModel.resolveDirection(
      dx: sampleDx,
      dy: sampleDy,
      active: active,
      sampled: sampled
    )
    let offset = DPadModel.thumbOffset(dx: sampleDx, dy: sampleDy, direction: next)
    thumb = CGSize(width: offset.x, height: offset.y)
    activate(next)
  }

  private func armSample() {
    sampleTask?.cancel()
    sampled = false
    sampleTask = Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(DPadModel.sampleMs))
      guard !Task.isCancelled, gestureLive else { return }
      sampled = true
      applyCurrent()
    }
  }

  /// A swipe that lifts before the sample timer still sends the measured axis once.
  private func commitIfNeeded() {
    sampleTask?.cancel()
    sampleTask = nil
    guard active == nil else { return }
    let next = DPadModel.resolveDirection(
      dx: sampleDx,
      dy: sampleDy,
      active: nil,
      sampled: true
    )
    guard let next else { return }
    Self.feedback.impactOccurred()
    onArrow(next)
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
    sampleTask?.cancel()
    sampleTask = nil
    stopRepeat()
    active = nil
    sampleDx = 0
    sampleDy = 0
    sampled = false
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
