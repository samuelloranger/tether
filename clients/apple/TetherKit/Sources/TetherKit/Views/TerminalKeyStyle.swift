#if canImport(UIKit)
import SwiftUI

/// The utility bar's key. Lit face + brief press so the one row whose job is to
/// send an invisible byte shows it landed. Under Reduce Motion it lights but doesn't travel.
struct TerminalKeyStyle: ButtonStyle {
  /// Latched state — Ctrl, which stays on until it is spent.
  var armed = false

  func makeBody(configuration: Configuration) -> some View {
    // A nested View, not the style itself: `@Environment` read directly on a
    // ButtonStyle isn't kept up to date (a style is a value, not a graph view).
    KeyFace(armed: armed, pressed: configuration.isPressed) {
      configuration.label
    }
  }

  private struct KeyFace<Label: View>: View {
    let armed: Bool
    let pressed: Bool
    @ViewBuilder var label: () -> Label

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 8, style: .continuous) }

    var body: some View {
      label()
        .font(.callout.weight(.medium))
        .padding(.horizontal, 10)
        .frame(minWidth: TerminalAccessoryBar.keySize, minHeight: TerminalAccessoryBar.keySize)
        .foregroundStyle(armed ? TetherColors.onAccent : TetherColors.textPrimary)
        .background(armed ? TetherColors.accent : TetherColors.surfaceRaised)
        // Tinted from the foreground rather than white, so the press reads the
        // same on the light theme as it does at night.
        .overlay(
          shape.fill(
            (armed ? TetherColors.onAccent : TetherColors.textPrimary)
              .opacity(pressed ? 0.12 : 0)
          )
        )
        .clipShape(shape)
        .scaleEffect(pressed && !reduceMotion ? 0.94 : 1)
        .animation(.easeOut(duration: TetherMotion.feedback), value: pressed)
        .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: armed)
    }
  }
}
#endif
