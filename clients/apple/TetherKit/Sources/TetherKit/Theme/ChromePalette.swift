import Foundation

/// The app's chrome colours, from the chosen terminal theme, as 0xRRGGBB. Windows derives
/// the same palettes (`tether-core/src/chrome.rs`); a golden file both test suites read
/// keeps them identical.
public struct ChromePalette: Hashable, Sendable {
  public var background: UInt32
  public var surface: UInt32
  public var surfaceHover: UInt32
  public var raised: UInt32
  public var input: UInt32
  public var border: UInt32
  public var text: UInt32
  public var textSecondary: UInt32
  public var textFaint: UInt32
  public var placeholder: UInt32
  public var accent: UInt32
  public var onAccent: UInt32
  public var success: UInt32
  public var warning: UInt32
  public var danger: UInt32
  public var onDanger: UInt32
  public var well: UInt32

  /// Aurora dark, Tether's own look.
  public static let tether = ChromePalette(
    background: 0x08080E, surface: 0x12121D, surfaceHover: 0x161624, raised: 0x191926,
    input: 0x0B0B13, border: 0x232333, text: 0xEDEEF6, textSecondary: 0x9797AC,
    textFaint: 0x8B8BA3, placeholder: 0x5C5C73, accent: 0x7C8CF8, onAccent: 0x08080E,
    success: 0x6EE7A8, warning: 0xF2B34C, danger: 0xFF7050, onDanger: 0x1A0A07, well: 0x1E1E2E
  )

  /// Aurora light.
  public static let tetherLight = ChromePalette(
    background: 0xF1F1F6, surface: 0xFFFFFF, surfaceHover: 0xF7F7FB, raised: 0xE9E9F2,
    input: 0xFFFFFF, border: 0xDCDCE6, text: 0x14141B, textSecondary: 0x5C5C6C,
    textFaint: 0x8A8A9C, placeholder: 0xA3A3B3, accent: 0x4353D0, onAccent: 0xFFFFFF,
    success: 0x1C7A4F, warning: 0x8A5A00, danger: 0xC4381C, onDanger: 0xFFFFFF, well: 0xFBFBFD
  )

  public static func derive(_ theme: TerminalTheme) -> ChromePalette {
    let bg = theme.background & 0xFFFFFF
    let fg = theme.foreground & 0xFFFFFF
    let ansi = theme.ansi.map { $0 & 0xFFFFFF }
    // Toward black or white a state colour keeps its hue; toward a tinted foreground,
    // a light theme's three state colours drift into one.
    let pole: UInt32 = theme.isLight ? 0x000000 : 0xFFFFFF
    let surface = mix(bg, fg, 0.05)
    let blue = contrast(ansi[4], bg) >= contrast(ansi[12], bg) ? ansi[4] : ansi[12]
    let accent = lift(blue, against: bg, toward: pole, ratio: 4.5)
    let danger = lift(ansi[1], against: bg, toward: pole, ratio: 4.5)
    func on(_ c: UInt32) -> UInt32 { contrast(bg, c) >= contrast(fg, c) ? bg : fg }
    return ChromePalette(
      background: bg,
      surface: surface,
      surfaceHover: mix(bg, fg, 0.075),
      raised: mix(bg, fg, 0.10),
      input: mix(bg, fg, 0.03),
      border: mix(bg, fg, 0.16),
      text: fg,
      textSecondary: liftText(mix(fg, bg, 0.35), against: surface, fg: fg, pole: pole, ratio: 4.5),
      textFaint: liftText(mix(fg, bg, 0.55), against: surface, fg: fg, pole: pole, ratio: 3.0),
      placeholder: mix(fg, bg, 0.62),
      accent: accent,
      onAccent: on(accent),
      success: lift(ansi[2], against: bg, toward: pole, ratio: 4.5),
      warning: lift(ansi[3], against: bg, toward: pole, ratio: 4.5),
      danger: danger,
      onDanger: on(danger),
      well: bg
    )
  }

  private static func channel(_ c: UInt32, _ shift: UInt32) -> Double { Double((c >> shift) & 0xFF) }

  /// Per sRGB channel, rounded half away from zero.
  static func mix(_ a: UInt32, _ b: UInt32, _ t: Double) -> UInt32 {
    [UInt32(16), 8, 0].reduce(0) { out, shift in
      let (x, y) = (channel(a, shift), channel(b, shift))
      return out | (UInt32((x + (y - x) * t).rounded()) << shift)
    }
  }

  private static func luminance(_ c: UInt32) -> Double {
    func linear(_ v: Double) -> Double {
      let v = v / 255
      return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linear(channel(c, 16)) + 0.7152 * linear(channel(c, 8)) + 0.0722 * linear(channel(c, 0))
  }

  /// The WCAG 2 contrast ratio.
  static func contrast(_ a: UInt32, _ b: UInt32) -> Double {
    let (la, lb) = (luminance(a), luminance(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }

  /// `c`, or the first 5 % step toward `toward` that reaches `ratio` against `against`.
  private static func lift(_ c: UInt32, against: UInt32, toward: UInt32, ratio: Double) -> UInt32 {
    guard contrast(c, against) < ratio else { return c }
    var out = c
    for k in 1...20 {
      out = mix(c, toward, Double(k) * 0.05)
      if contrast(out, against) >= ratio { break }
    }
    return out
  }

  /// Text lifts toward the foreground; a theme whose own foreground is too faint for the
  /// ratio carries on toward black or white.
  private static func liftText(_ c: UInt32, against: UInt32, fg: UInt32, pole: UInt32, ratio: Double) -> UInt32 {
    let towardForeground = lift(c, against: against, toward: fg, ratio: ratio)
    guard contrast(towardForeground, against) < ratio else { return towardForeground }
    return lift(towardForeground, against: against, toward: pole, ratio: ratio)
  }
}

public extension TerminalTheme {
  var chrome: ChromePalette {
    switch id {
    case TerminalTheme.tether.id: .tether
    case TerminalTheme.tetherLight.id: .tetherLight
    default: .derive(self)
    }
  }
}
