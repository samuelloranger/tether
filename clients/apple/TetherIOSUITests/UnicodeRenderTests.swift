import XCTest

/// Test #16 — wide (CJK) and multibyte characters must render, not corrupt the
/// grid. The typed command is pure ASCII (`printf` with \u escapes) so the test
/// input can't itself drop the unicode; the SHELL emits 你好 and an accented char.
final class UnicodeRenderTests: TetherUITestCase {
  func testWideAndMultibyteCharactersRender() throws {
    let app = launchApp()
    tapNewTerminal(app)
    focusAndType(app, "printf 'UNI_START \\u4f60\\u597d caf\\u00e9 UNI_END\\n'\n")
    sleep(3)
    dumpGrid(app, "client-grid-unicode")
  }
}
