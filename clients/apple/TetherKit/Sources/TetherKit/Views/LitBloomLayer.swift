import SwiftUI

/// The app's atmospheric bloom: the active session's heat colour, soft and
/// off-centre, sitting behind everything.
///
/// This was an `if` around a `RadialGradient` in `RootView`, which meant the
/// glow appeared and vanished on a frame boundary — the app's one continuous
/// signal that a shell is alive changed by hard cut. Here the two states
/// crossfade (`.id` + `.transition`, since gradient colours themselves do not
/// interpolate), on the asymmetric curve from `TetherMotion`: heat arrives in
/// a quarter second, and takes most of a second to leave.
///
/// Entering `waiting` also gets the surface's one authored moment — a single
/// swell of the same glow, no repeat, no loop. It is the moment the product is
/// for: the shell has stopped and is asking you something.
public struct LitBloomLayer: View {
  public var chrome: LitChrome

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var pulse: Double = 0

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
    .onChange(of: chrome.state) { old, new in
      guard TetherMotion.pulses(from: old, to: new, reduceMotion: reduceMotion) else { return }
      withAnimation(TetherMotion.decelerate(TetherMotion.pulseRise)) {
        pulse = 1
      } completion: {
        withAnimation(.easeOut(duration: TetherMotion.pulseFall)) {
          pulse = 0
        }
      }
    }
  }
}
