import SwiftUI

/// The app's atmospheric bloom: the active session's heat colour behind everything.
/// States crossfade via `.id`+`.transition` (gradient colours don't interpolate); waiting swells once.
public struct LitBloomLayer: View {
  public var chrome: LitChrome

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var pulse: Double = 0
  /// Whether the chrome has shown a live state yet — see `TetherMotion.pulses`.
  @State private var settled: Bool = false

  public init(chrome: LitChrome) {
    self.chrome = chrome
  }

  public var body: some View {
    ZStack {
      if chrome.state != .none {
        RadialGradient(
          colors: [
            chrome.color.opacity(chrome.bloom.b1 * LitBloom.pulseGain),
            chrome.color.opacity(chrome.bloom.b2 * LitBloom.pulseGain),
            chrome.color.opacity(chrome.bloom.b3 * LitBloom.pulseGain),
            .clear,
          ],
          center: .init(x: 0.72, y: 0.28),
          startRadius: 20,
          endRadius: 420
        )
        .id(chrome.state)
        .transition(.opacity)
      }
    }
    // At rest this renders exactly the alphas LitBloom documents; the swell
    // spends the headroom the gain reserved.
    .opacity(LitBloom.restOpacity + (1 - LitBloom.restOpacity) * pulse)
    .ignoresSafeArea()
    .allowsHitTesting(false)
    .animation(TetherMotion.heat(to: chrome.state, reduceMotion: reduceMotion), value: chrome.state)
    .onChange(of: chrome.state, initial: true) { old, new in
      let wasSettled = settled
      if new != .none { settled = true }

      guard TetherMotion.pulses(
        from: old,
        to: new,
        settled: wasSettled,
        reduceMotion: reduceMotion
      ) else {
        // Leaving `waiting` mid-swell, the bloom has already crossfaded colour, so
        // the leftover brightness is a dead state — take it back, don't let it fall.
        if pulse != 0 {
          withAnimation(.easeOut(duration: TetherMotion.pulseCancel)) { pulse = 0 }
        }
        return
      }

      withAnimation(TetherMotion.decelerate(TetherMotion.pulseRise)) {
        pulse = 1
      } completion: {
        // Only the swell that is still current gets to fade itself out; a later
        // state change has already taken the brightness back above.
        if chrome.state == .waiting {
          withAnimation(.easeOut(duration: TetherMotion.pulseFall)) { pulse = 0 }
        }
      }
    }
  }
}
