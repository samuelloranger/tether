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

  func test_colors_a_program_set_with_osc4_survive_a_theme_switch() {
    let engine = TerminalEngine(cols: 10, rows: 2)
    // Entry 1 (red) and entry 200 (from the xterm cube) repainted by the program.
    engine.feed("\u{1B}]4;1;rgb:12/34/56;200;rgb:ab/cd/ef\u{1B}\\\u{1B}[31mR\u{1B}[38;5;200mC\u{1B}[32mG")
    engine.setTheme(dracula)
    let cells = engine.frame().cells
    XCTAssertEqual(cells[0].foreground, 0xFF12_3456, "the program's red was replaced by the theme's")
    XCTAssertEqual(cells[1].foreground, 0xFFAB_CDEF)
    XCTAssertEqual(cells[2].foreground, dracula.ansi[2], "an untouched entry follows the new theme")
  }

  func test_an_osc4_color_equal_to_the_old_themes_is_still_the_programs() {
    let engine = TerminalEngine(cols: 10, rows: 2)
    // The program sets red to exactly the Tether theme's red.
    engine.feed("\u{1B}]4;1;rgb:f3/8b/a8\u{07}\u{1B}[31mR")
    engine.setTheme(dracula)
    XCTAssertEqual(engine.frame().cells[0].foreground, 0xFFF3_8BA8)
  }

  func test_an_entry_reset_with_osc104_or_ris_follows_the_new_theme() {
    let reset = TerminalEngine(cols: 10, rows: 2)
    reset.feed("\u{1B}]4;1;rgb:12/34/56\u{1B}\\\u{1B}]104;1\u{1B}\\\u{1B}[31mR")
    reset.setTheme(dracula)
    XCTAssertEqual(reset.frame().cells[0].foreground, dracula.ansi[1])

    let hard = TerminalEngine(cols: 10, rows: 2)
    hard.feed("\u{1B}]4;1;rgb:12/34/56\u{1B}\\\u{1B}c\u{1B}[31mR")
    hard.setTheme(dracula)
    XCTAssertEqual(hard.frame().cells[0].foreground, dracula.ansi[1])
  }

  func test_override_tracking_survives_split_reads_ignores_queries_and_control_strings() {
    var scanner = OSCScanner()
    var overrides = PaletteOverrides()
    let feed = { (text: String) in for event in scanner.scan(Array(text.utf8)) { overrides.apply(event) } }
    for chunk in ["\u{1B}]", "4;7", ";rgb:1/2/3;9;?", "\u{1B}", "\\"] { feed(chunk) }
    XCTAssertEqual(overrides.indices, [7])
    // Inside a kitty graphics APC payload: not a palette command.
    feed("\u{1B}_Gq=2;\u{1B}]4;3;rgb:9/9/9\u{07}\u{1B}\\")
    XCTAssertEqual(overrides.indices, [7])
    feed("\u{1B}]4;200;#ffffff\u{07}\u{1B}]104\u{07}")
    XCTAssertEqual(overrides.indices, [])
  }

  func test_a_grid_rebuilt_from_truncated_output_keeps_the_programs_colors() {
    let live = TerminalEngine(cols: 10, rows: 2)
    live.feed("\u{1B}]4;1;rgb:12/34/56\u{07}")
    // The rebuild's buffer no longer holds the OSC 4.
    let rebuilt = TerminalEngine(cols: 10, rows: 2)
    rebuilt.restorePaletteOverrides(live.paletteOverrideEntries())
    rebuilt.feed("\u{1B}[31mR")
    XCTAssertEqual(rebuilt.frame().cells[0].foreground, 0xFF12_3456)
    rebuilt.setTheme(dracula)
    XCTAssertEqual(rebuilt.frame().cells[0].foreground, 0xFF12_3456, "the carried entry isn't tracked as the program's")
  }

  func test_the_palette_sequence_is_one_osc4() {
    XCTAssertEqual(
      TerminalEngine.paletteSequence([(1, 0xFF12_3456), (200, 0xFFAB_CDEF)]),
      "\u{1B}]4;1;rgb:12/34/56;200;rgb:ab/cd/ef\u{1B}\\"
    )
  }

  func test_a_pipeline_starts_its_first_grid_in_the_given_theme() async {
    let pipeline = TerminalPipeline(theme: dracula)
    await pipeline.attachForTest(cols: 10, rows: 2)
    let frame = await pipeline.frameForTest()
    XCTAssertEqual(frame?.cells[0].background, dracula.background)
  }

  func test_an_older_theme_request_arriving_late_is_ignored() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 10, rows: 2)
    await pipeline.setTheme(TerminalTheme.named("nord"), sequence: 2)
    await pipeline.setTheme(dracula, sequence: 1)
    let frame = await pipeline.frameForTest()
    XCTAssertEqual(frame?.cells[0].background, TerminalTheme.named("nord").background)
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
