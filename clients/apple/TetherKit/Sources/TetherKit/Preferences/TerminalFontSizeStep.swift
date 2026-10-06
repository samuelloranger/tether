import Foundation

/// The View menu's Bigger / Smaller / Actual Size, shared with the settings stepper
/// so both clamp to the same range.
public enum TerminalFontSizeStep {
  public static let range: ClosedRange<Double> = 8...24
  public static let step: Double = 1

  public static func bigger(_ size: Double) -> Double { clamped(size + step) }
  public static func smaller(_ size: Double) -> Double { clamped(size - step) }

  public static func clamped(_ size: Double) -> Double {
    min(max(size, range.lowerBound), range.upperBound)
  }
}

extension AppPreferences {
  func makeTerminalTextBigger() { terminalFontSize = TerminalFontSizeStep.bigger(terminalFontSize) }
  func makeTerminalTextSmaller() { terminalFontSize = TerminalFontSizeStep.smaller(terminalFontSize) }
  func resetTerminalTextSize() { terminalFontSize = Self.defaultTerminalFontSize }
}
