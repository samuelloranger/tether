#if canImport(UIKit)
import SwiftUI

/// Floating terminal D-pad: drag for a locked cardinal + capped auto-repeat.
///
/// Port of `apps/mobile/src/Dpad.tsx`. Position is owned by the parent so the
/// pad can be dragged around the terminal surface.
public struct DpadView: View {
  public var onArrow: (DPadDirection) -> Void

  @State private var thumb = CGSize.zero
  @State private var active: DPadDirection?
  @State private var grantOrigin = CGPoint.zero
  @State private var gestureLive = false
  @State private var repeatTask: Task<Void, Never>?

  public init(onArrow: @escaping (DPadDirection) -> Void) {
    self.onArrow = onArrow
  }

  public var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 8)
        .fill(TetherColors.surface)
      glyph
    }
    .frame(width: DPadModel.buttonSize, height: DPadModel.buttonSize)
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
            locationY: value.startLocation.y
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
    withAnimation(.spring(response: 0.28, dampingFraction: 0.7)) {
      thumb = .zero
    }
  }

  private func stopRepeat() {
    repeatTask?.cancel()
    repeatTask = nil
  }
}

/// Draggable chrome around `DpadView` so the puck can float over the terminal.
public struct FloatingDpad: View {
  public var onArrow: (DPadDirection) -> Void
  @Binding public var position: CGPoint
  @State private var dragOrigin: CGPoint?

  public init(position: Binding<CGPoint>, onArrow: @escaping (DPadDirection) -> Void) {
    _position = position
    self.onArrow = onArrow
  }

  public var body: some View {
    VStack(spacing: 6) {
      Capsule()
        .fill(TetherColors.textSecondary.opacity(0.5))
        .frame(width: 28, height: 4)
        .padding(.top, 6)
        .gesture(
          DragGesture()
            .onChanged { value in
              if dragOrigin == nil { dragOrigin = position }
              if let dragOrigin {
                position = CGPoint(
                  x: dragOrigin.x + value.translation.width,
                  y: dragOrigin.y + value.translation.height
                )
              }
            }
            .onEnded { _ in dragOrigin = nil }
        )
        .accessibilityLabel("Move D-pad")
      DpadView(onArrow: onArrow)
        .padding(.horizontal, 6)
        .padding(.bottom, 6)
    }
    .background(TetherColors.surface.opacity(0.92))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .position(position)
  }
}
#endif
