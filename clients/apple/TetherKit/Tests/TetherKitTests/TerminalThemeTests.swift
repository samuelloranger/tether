import XCTest
@testable import TetherKit

final class TerminalThemeTests: XCTestCase {
  private var dracula: TerminalTheme { TerminalTheme.named("dracula") }

  func test_the_catalog_starts_with_tethers_theme_and_bundles_the_rest() {
    let catalog = TerminalTheme.catalog
    XCTAssertEqual(catalog.first, .tether)
    XCTAssertGreaterThan(catalog.count, 40)
    XCTAssertEqual(Set(catalog.map(\.id)).count, catalog.count, "ids must be unique")
    XCTAssertTrue(catalog.allSatisfy { $0.ansi.count == 16 })
    XCTAssertEqual(dracula.background, 0xFF28_2A36)
    XCTAssertEqual(dracula.ansi[1], 0xFFFF_5555)
  }

  func test_an_unknown_id_falls_back_to_tethers_theme() {
    XCTAssertEqual(TerminalTheme.named("gone"), .tether)
  }

  func test_light_and_dark_follow_the_background() {
    XCTAssertTrue(TerminalTheme.named("catppuccin-latte").isLight)
    XCTAssertFalse(TerminalTheme.named("catppuccin-mocha").isLight)
    XCTAssertFalse(TerminalTheme.tether.isLight)
  }

  func test_malformed_entries_are_skipped() {
    let json = """
    [{"id": "ok", "name": "OK", "background": "000000", "foreground": "FFFFFF", "cursor": "FFFFFF",
      "ansi": ["000000","111111","222222","333333","444444","555555","666666","777777",
               "888888","999999","AAAAAA","BBBBBB","CCCCCC","DDDDDD","EEEEEE","FFFFFF"]},
     {"id": "short", "name": "Short", "background": "000000", "foreground": "FFFFFF", "cursor": "FFFFFF",
      "ansi": ["000000"]},
     {"id": "bad", "name": "Bad", "background": "nothex", "foreground": "FFFFFF", "cursor": "FFFFFF",
      "ansi": []}]
    """
    let themes = TerminalTheme.bundled(from: Data(json.utf8))
    XCTAssertEqual(themes.map(\.id), ["ok"])
    XCTAssertNil(themes.first?.selection)
  }

  func test_a_themed_engine_draws_blank_cells_and_ansi_colors_from_the_theme() {
    let engine = TerminalEngine(cols: 10, rows: 2, theme: dracula)
    engine.feed("\u{1B}[31mR")
    let frame = engine.frame()
    XCTAssertEqual(frame.cells[0].foreground, dracula.ansi[1])
    XCTAssertEqual(frame.cells[0].background, dracula.background)
    XCTAssertEqual(frame.cells[5], TerminalPalette.blankCell(for: dracula))
  }

  func test_switching_themes_repaints_what_is_already_on_screen() {
    let engine = TerminalEngine(cols: 10, rows: 2)
    engine.feed("\u{1B}[31mR\u{1B}[0mx")
    let before = engine.frame()
    engine.setTheme(dracula)
    let after = engine.frame()
    XCTAssertGreaterThan(after.header.generation, before.header.generation)
    XCTAssertEqual(after.cells[0].foreground, dracula.ansi[1])
    XCTAssertEqual(after.cells[1].foreground, dracula.foreground)
    XCTAssertEqual(after.cells[9].background, dracula.background)
  }

  func test_setting_the_same_theme_is_a_no_op() {
    let engine = TerminalEngine(cols: 10, rows: 2, theme: dracula)
    let before = engine.frame()
    engine.setTheme(dracula)
    XCTAssertEqual(engine.frame().header.generation, before.header.generation)
  }

  func test_kept_session_grids_and_new_ones_take_the_current_theme() {
    let grids = TerminalSessionGrids()
    let kept = grids.attach(key: "a", cols: 10, rows: 2).grid
    grids.theme = dracula
    XCTAssertEqual(kept.emulator.frame().cells[0].background, dracula.background)
    let fresh = grids.attach(key: "b", cols: 10, rows: 2).grid
    XCTAssertEqual(fresh.emulator.frame().cells[0].background, dracula.background)
  }

  func test_a_rebuilt_grid_keeps_the_theme() {
    let buffer = TerminalOutputBuffer()
    buffer.append(Data("hi".utf8))
    XCTAssertEqual(buffer.replay(cols: 10, rows: 2, theme: dracula).frame().cells[0].background, dracula.background)
  }
}
