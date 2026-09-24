import CoreGraphics
import UIKit
import XCTest
@testable import TetherKit

/// Kitty graphics through the engine and onto the bitmap.
final class TerminalImageTests: XCTestCase {
  /// 2×2: a red top row over a blue bottom row, so a flipped draw shows.
  private let redOverBlue: [UInt8] = [
    255, 0, 0, 255, 255, 0, 0, 255,
    0, 0, 255, 255, 0, 0, 255, 255,
  ]

  private func kitty(_ control: String, _ rgba: [UInt8]? = nil) -> String {
    let payload = rgba.map { Data($0).base64EncodedString() } ?? ""
    return "\u{1B}_G\(control)\(payload.isEmpty ? "" : ";" + payload)\u{1B}\\"
  }

  // MARK: - engine

  func test_a_transmitted_image_is_placed_at_the_cursor() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.setCellPixelSize(width: 10, height: 20)
    engine.feed("ab" + kitty("a=T,f=32,s=2,v=2,q=2", redOverBlue))
    let layer = engine.frame().images
    XCTAssertEqual(layer.placements.count, 1)
    let placement = layer.placements[0]
    XCTAssertEqual([placement.col, placement.row, placement.cols, placement.rows], [2, 0, 1, 1])
    XCTAssertTrue(placement.aboveText)
    XCTAssertEqual(layer.bitmaps[placement.key]?.rgba, redOverBlue)
  }

  func test_the_cell_box_follows_the_reported_pixel_size() {
    let engine = TerminalEngine(cols: 40, rows: 10)
    engine.setCellPixelSize(width: 10, height: 20)
    let wide = [UInt8](repeating: 200, count: 45 * 50 * 4)
    engine.feed(kitty("a=T,f=32,s=45,v=50,q=2", wide))
    let placement = engine.frame().images.placements.first
    XCTAssertEqual(placement?.cols, 5)
    XCTAssertEqual(placement?.rows, 3)
  }

  func test_explicit_columns_and_rows_win_and_a_negative_z_goes_under_text() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.setCellPixelSize(width: 10, height: 20)
    engine.feed(kitty("a=T,f=32,s=2,v=2,c=6,r=3,z=-1,q=2", redOverBlue))
    let placement = engine.frame().images.placements.first
    XCTAssertEqual(placement?.cols, 6)
    XCTAssertEqual(placement?.rows, 3)
    XCTAssertEqual(placement?.aboveText, false)
  }

  func test_deleting_images_clears_the_layer_and_bumps_the_generation() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed(kitty("a=T,f=32,s=2,v=2,q=2", redOverBlue))
    let shown = engine.frame()
    XCTAssertFalse(shown.images.isEmpty)
    engine.feed(kitty("a=d,d=A,q=2"))
    let cleared = engine.frame()
    XCTAssertTrue(cleared.images.isEmpty)
    XCTAssertGreaterThan(cleared.header.generation, shown.header.generation)
  }

  func test_the_cell_pixel_size_answers_the_programs_query() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.setCellPixelSize(width: 12, height: 26)
    engine.feed("\u{1B}[16t")
    XCTAssertEqual(String(decoding: engine.takeReplies(), as: UTF8.self), "\u{1B}[6;26;12t")
  }

  func test_sixel_is_not_claimed_so_tools_pick_kitty_graphics() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.feed("\u{1B}[c")
    let reply = String(decoding: engine.takeReplies(), as: UTF8.self)
    let attributes = reply.dropFirst(3).dropLast().split(separator: ";")
    XCTAssertFalse(attributes.contains("4"), reply)
  }

  // MARK: - layout and drawing

  private func metrics(cols: Int, rows: Int) -> TerminalRenderMetrics {
    let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    return TerminalRenderMetrics(
      cellWidth: 10, cellHeight: 20,
      size: CGSize(width: 10 * CGFloat(cols), height: 20 * CGFloat(rows)),
      scale: 2, font: font,
      boldFont: UIFont.monospacedSystemFont(ofSize: 14, weight: .bold),
      background: UIColor.black.cgColor
    )
  }

  private func placement(col: Int = 0, row: Int = 0, cols: Int, rows: Int, width: Int = 2, height: Int = 2)
    -> TerminalImageLayer.Placement
  {
    TerminalImageLayer.Placement(
      key: .init(id: 1, generation: 1),
      sourceX: 0, sourceY: 0, sourceWidth: width, sourceHeight: height,
      col: col, row: row, cols: cols, rows: rows, offsetX: 0, offsetY: 0, aboveText: true
    )
  }

  func test_an_image_is_aspect_fit_into_its_cell_box_from_the_top_left() {
    let rect = TerminalGridRenderer.imageRect(
      placement(col: 1, row: 2, cols: 4, rows: 1, width: 100, height: 50),
      originY: 5, metrics: metrics(cols: 8, rows: 4)
    )
    XCTAssertEqual(rect, CGRect(x: 10, y: 45, width: 40, height: 20))
  }

  func test_image_rows_count_as_painted_on_the_alt_screen() {
    let blank = [GridSnapshot.Cell](repeating: TerminalPalette.blankCell, count: 4 * 6)
    let layer = TerminalImageLayer(bitmaps: [:], placements: [placement(row: 1, cols: 2, rows: 3)])
    XCTAssertEqual(TerminalGridLayout.paintedRows(cells: blank, cols: 4, rows: 6, altScreen: true), 0)
    XCTAssertEqual(TerminalGridLayout.paintedRows(cells: blank, cols: 4, rows: 6, altScreen: true, images: layer), 4)
  }

  func test_the_renderer_draws_the_image_upright_in_its_box() {
    let cols = 4, rows = 2
    let layer = TerminalImageLayer(
      bitmaps: [.init(id: 1, generation: 1): .init(width: 2, height: 2, rgba: redOverBlue)],
      placements: [placement(cols: 2, rows: 2)]
    )
    let black = GridSnapshot.Cell(codepoint: 0x20, foreground: 0xFFFF_FFFF, background: 0xFF00_0000, attrs: 0)
    let cells = [GridSnapshot.Cell](repeating: black, count: cols * rows)
    let header = GridSnapshot.Header(
      cols: UInt16(cols), rows: UInt16(rows), cursorCol: 0, cursorRow: 0, generation: 1, cursorVisible: false
    )
    guard let image = TerminalGridRenderer().render(
      header: header, cells: cells, images: layer, metrics: metrics(cols: cols, rows: rows)
    ) else { return XCTFail("no image") }
    // The box is 20×40 pt; aspect-fit makes the image 20×20 pt at the top left (40×40 px).
    let top = pixel(image, x: 10, y: 10)
    let bottom = pixel(image, x: 10, y: 30)
    let outside = pixel(image, x: 60, y: 10)
    XCTAssertGreaterThan(top.r, 200, "top half should be red: \(top)")
    XCTAssertLessThan(top.b, 60)
    XCTAssertGreaterThan(bottom.b, 200, "bottom half should be blue: \(bottom)")
    XCTAssertLessThan(bottom.r, 60)
    XCTAssertLessThan(outside.r + outside.g + outside.b, 60, "the image spilled out of its box")
  }

  /// Device pixel at (x, y) from the top left.
  private func pixel(_ image: CGImage, x: Int, y: Int) -> (r: Int, g: Int, b: Int) {
    let width = image.width, height = image.height
    var raw = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(
      data: &raw, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return (0, 0, 0) }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    let offset = (y * width + x) * 4
    return (Int(raw[offset]), Int(raw[offset + 1]), Int(raw[offset + 2]))
  }
}
