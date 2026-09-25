import SwiftUI

/// The utility bar's key. Lit face + brief press so the one row whose job is to
/// send an invisible byte shows it landed. Under Reduce Motion it lights but doesn't travel.
struct TerminalKeyStyle: ButtonStyle {
  /// Latched state — Ctrl, which stays on until it is spent.
  var armed = false
  static let cornerRadius: CGFloat = 8

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
    @Environment(\.terminalKeyMetrics) private var metrics

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: TerminalKeyStyle.cornerRadius, style: .continuous) }

    var body: some View {
      label()
        .font(metrics.font)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .padding(.horizontal, 4)
        .frame(width: metrics.keyWidth, height: metrics.keySize)
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

/// Key and bar dimensions. Every key is the same size, the D-pad included — a key larger
/// than its neighbours reads as a different kind of thing. Width fits "Home"/"PgDn".
public struct TerminalKeyMetrics: Equatable {
  public var keySize: CGFloat
  public var keyWidth: CGFloat
  public var barVerticalPadding: CGFloat
  var font: Font

  /// The bar's height, derived from key + padding so it cannot drift from the row's layout.
  public var barHeight: CGFloat { keySize + barVerticalPadding * 2 }

  public static let regular = TerminalKeyMetrics(
    keySize: 40, keyWidth: 52, barVerticalPadding: 8, font: .callout.weight(.medium)
  )
  public static let compact = TerminalKeyMetrics(
    keySize: 32, keyWidth: 42, barVerticalPadding: 6, font: .footnote.weight(.medium)
  )
}

private struct TerminalKeyMetricsKey: EnvironmentKey {
  static let defaultValue = TerminalKeyMetrics.regular
}

extension EnvironmentValues {
  var terminalKeyMetrics: TerminalKeyMetrics {
    get { self[TerminalKeyMetricsKey.self] }
    set { self[TerminalKeyMetricsKey.self] = newValue }
  }
}
