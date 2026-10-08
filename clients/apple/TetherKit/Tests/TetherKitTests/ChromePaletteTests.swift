import Foundation
import XCTest
@testable import TetherKit

final class ChromePaletteTests: XCTestCase {
  private struct GoldenEntry: Decodable {
    let id: String
    let tokens: [String: String]
  }

  private func tokens(_ p: ChromePalette) -> [String: UInt32] {
    [
      "background": p.background, "surface": p.surface, "surfaceHover": p.surfaceHover,
      "raised": p.raised, "input": p.input, "border": p.border, "text": p.text,
      "textSecondary": p.textSecondary, "textFaint": p.textFaint, "placeholder": p.placeholder,
      "accent": p.accent, "onAccent": p.onAccent, "success": p.success, "warning": p.warning,
      "danger": p.danger, "onDanger": p.onDanger, "well": p.well,
    ]
  }

  /// Written by the Windows core's tests (`UPDATE_GOLDEN=1 cargo test -p tether-core chrome`):
  /// both apps must derive the same colours from the same theme.
  func test_every_theme_matches_the_shared_golden_file() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("Fixtures/ChromePalettes.golden.json")
    let golden = try JSONDecoder().decode([GoldenEntry].self, from: Data(contentsOf: url))
    XCTAssertEqual(golden.map(\.id), TerminalTheme.catalog.map(\.id))
    for (entry, theme) in zip(golden, TerminalTheme.catalog) {
      let expected = entry.tokens.mapValues { UInt32($0, radix: 16) }
      let actual = tokens(theme.chrome).mapValues { Optional($0) }
      XCTAssertEqual(actual, expected, theme.id)
    }
  }

  func test_tether_and_tether_light_are_aurora() {
    XCTAssertEqual(TerminalTheme.tether.chrome, .tether)
    XCTAssertEqual(TerminalTheme.tetherLight.chrome, .tetherLight)
    XCTAssertEqual(ChromePalette.tether.background, 0x08080E)
    XCTAssertEqual(ChromePalette.tether.well, 0x1E1E2E)
    XCTAssertEqual(ChromePalette.tetherLight.accent, 0x4353D0)
    XCTAssertEqual(TerminalTheme.named("gone").chrome, .tether)
  }

  func test_tether_light_follows_tether_in_the_catalog() {
    XCTAssertEqual(TerminalTheme.catalog.prefix(2).map(\.id), ["tether", "tether-light"])
    XCTAssertTrue(TerminalTheme.tetherLight.isLight)
  }

  func test_derived_palettes_keep_text_and_states_legible() {
    for theme in TerminalTheme.catalog where !theme.id.hasPrefix("tether") {
      let p = theme.chrome
      XCTAssertGreaterThanOrEqual(ChromePalette.contrast(p.text, p.surface), 4.5, "\(theme.id) text")
      XCTAssertGreaterThanOrEqual(
        ChromePalette.contrast(p.text, p.surface), ChromePalette.contrast(p.textSecondary, p.surface),
        "\(theme.id) secondary outranks text"
      )
      XCTAssertGreaterThanOrEqual(ChromePalette.contrast(p.textSecondary, p.surface), 4.5, "\(theme.id) secondary")
      XCTAssertGreaterThanOrEqual(ChromePalette.contrast(p.textFaint, p.surface), 3.0, "\(theme.id) faint")
      for (name, color) in [("accent", p.accent), ("success", p.success), ("warning", p.warning), ("danger", p.danger)] {
        XCTAssertGreaterThanOrEqual(ChromePalette.contrast(color, p.background), 4.5, "\(theme.id) \(name)")
        XCTAssertGreaterThanOrEqual(ChromePalette.contrast(color, p.surface), 4.5, "\(theme.id) \(name) on surface")
      }
      XCTAssertEqual(p.well, theme.background & 0xFFFFFF)
    }
  }

  func test_mix_rounds_half_away_from_zero() {
    XCTAssertEqual(ChromePalette.mix(0x000000, 0x010101, 0.5), 0x010101)
    XCTAssertEqual(ChromePalette.mix(0x102030, 0x102030, 0.7), 0x102030)
  }

  // MARK: - Migration from the System / Dark / Light setting

  func test_light_on_tethers_theme_becomes_tether_light() {
    XCTAssertEqual(AppPreferences.migratedThemeID(savedTheme: "tether", savedScheme: "light", systemIsLight: false), "tether-light")
    XCTAssertEqual(AppPreferences.migratedThemeID(savedTheme: nil, savedScheme: "light", systemIsLight: false), "tether-light")
  }

  func test_system_follows_what_the_device_showed() {
    XCTAssertEqual(AppPreferences.migratedThemeID(savedTheme: "tether", savedScheme: "system", systemIsLight: true), "tether-light")
    XCTAssertNil(AppPreferences.migratedThemeID(savedTheme: "tether", savedScheme: "system", systemIsLight: false))
  }

  func test_dark_and_other_themes_are_left_alone() {
    XCTAssertNil(AppPreferences.migratedThemeID(savedTheme: "tether", savedScheme: "dark", systemIsLight: true))
    XCTAssertNil(AppPreferences.migratedThemeID(savedTheme: "dracula", savedScheme: "light", systemIsLight: true))
  }
  @MainActor
  func test_the_old_setting_migrates_once_and_is_removed() {
    let defaults = UserDefaults(suiteName: "chrome.migration.\(UUID().uuidString)")!
    defaults.set("light", forKey: "tether.colorScheme")
    AppPreferences.migrateColorScheme(in: defaults, deviceStyle: .dark)
    XCTAssertEqual(defaults.string(forKey: "tether.terminalTheme"), "tether-light")
    XCTAssertNil(defaults.string(forKey: "tether.colorScheme"))
  }

  /// Read too early, the device's style can be unknown; guessing would be permanent.
  @MainActor
  func test_system_waits_for_a_launch_that_knows_the_device_style() {
    let defaults = UserDefaults(suiteName: "chrome.migration.\(UUID().uuidString)")!
    defaults.set("system", forKey: "tether.colorScheme")
    AppPreferences.migrateColorScheme(in: defaults, deviceStyle: .unspecified)
    XCTAssertEqual(defaults.string(forKey: "tether.colorScheme"), "system")
    XCTAssertNil(defaults.string(forKey: "tether.terminalTheme"))
    AppPreferences.migrateColorScheme(in: defaults, deviceStyle: .light)
    XCTAssertEqual(defaults.string(forKey: "tether.terminalTheme"), "tether-light")
    XCTAssertNil(defaults.string(forKey: "tether.colorScheme"))
  }

  @MainActor
  func test_choosing_a_theme_repaints_the_chrome() {
    let preferences = AppPreferences()
    let saved = preferences.terminalThemeID
    defer { preferences.terminalThemeID = saved }
    preferences.terminalTheme = .tetherLight
    XCTAssertEqual(ChromeTheme.shared.palette, .tetherLight)
    XCTAssertTrue(ChromeTheme.shared.isLight)
    preferences.terminalTheme = .named("dracula")
    XCTAssertEqual(ChromeTheme.shared.palette, TerminalTheme.named("dracula").chrome)
  }
}
