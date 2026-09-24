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
    XCTAssertEqual(placement.depth, .aboveText)
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
    XCTAssertEqual(placement?.depth, .belowText)
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

  private func placement(
    col: Int = 0, row: Int = 0, cols: Int, rows: Int, width: Int = 2, height: Int = 2,
    owner: UInt64 = 1, depth: TerminalImageLayer.Depth = .aboveText
  ) -> TerminalImageLayer.Placement {
    TerminalImageLayer.Placement(
      key: .init(owner: owner, id: 1, generation: 1),
      sourceX: 0, sourceY: 0, sourceWidth: width, sourceHeight: height,
      col: col, row: row, cols: cols, rows: rows, offsetX: 0, offsetY: 0, depth: depth
    )
  }

  private let black = GridSnapshot.Cell(codepoint: 0x20, foreground: 0xFFFF_FFFF, background: 0xFF00_0000, attrs: 0)

  private func layer(_ rgba: [UInt8], _ placement: TerminalImageLayer.Placement) -> TerminalImageLayer {
    TerminalImageLayer(bitmaps: [placement.key: .init(width: 2, height: 2, rgba: rgba)], placements: [placement])
  }

  private func header(cols: Int, rows: Int, altScreen: Bool = false, generation: UInt64 = 1) -> GridSnapshot.Header {
    GridSnapshot.Header(
      cols: UInt16(cols), rows: UInt16(rows), cursorCol: 0, cursorRow: 0,
      generation: generation, cursorVisible: false, altScreen: altScreen
    )
  }

  private let solidRed: [UInt8] = Array(repeating: [255, 0, 0, 255], count: 4).flatMap { $0 }
  private let solidBlue: [UInt8] = Array(repeating: [0, 0, 255, 255], count: 4).flatMap { $0 }

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

  func test_text_above_an_image_does_not_cut_the_image_rows() {
    var cells = [GridSnapshot.Cell](repeating: TerminalPalette.blankCell, count: 4 * 6)
    cells[0].codepoint = 0x41
    let layer = TerminalImageLayer(bitmaps: [:], placements: [placement(row: 2, cols: 2, rows: 3)])
    XCTAssertEqual(TerminalGridLayout.paintedRows(cells: cells, cols: 4, rows: 6, altScreen: true, images: layer), 5)
  }

  func test_the_renderer_draws_the_image_upright_in_its_box() {
    let cols = 4, rows = 2
    let layer = TerminalImageLayer(
      bitmaps: [.init(owner: 1, id: 1, generation: 1): .init(width: 2, height: 2, rgba: redOverBlue)],
      placements: [placement(cols: 2, rows: 2)]
    )
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

  func test_two_sessions_with_the_same_image_id_never_share_pixels() throws {
    let a = TerminalEngine(cols: 20, rows: 5)
    let b = TerminalEngine(cols: 20, rows: 5)
    a.feed(kitty("a=T,f=32,s=2,v=2,i=7,q=2", solidRed))
    b.feed(kitty("a=T,f=32,s=2,v=2,i=7,q=2", solidBlue))
    let keyA = try XCTUnwrap(a.frame().images.placements.first?.key)
    let keyB = try XCTUnwrap(b.frame().images.placements.first?.key)
    XCTAssertEqual(keyA.id, keyB.id)
    XCTAssertNotEqual(keyA, keyB)

    // One renderer draws both, as one surface does across a session switch.
    let renderer = TerminalGridRenderer()
    let cells = [GridSnapshot.Cell](repeating: black, count: 4 * 2)
    _ = renderer.render(header: header(cols: 4, rows: 2), cells: cells, images: a.frame().images, metrics: metrics(cols: 4, rows: 2))
    let second = try XCTUnwrap(renderer.render(
      header: header(cols: 4, rows: 2, generation: 2), cells: cells, images: b.frame().images, metrics: metrics(cols: 4, rows: 2)
    ))
    let shown = pixel(second, x: 5, y: 5)
    XCTAssertGreaterThan(shown.b, 200, "session B shows session A's image: \(shown)")
  }

  func test_a_grid_rebuilt_from_the_output_keeps_the_cell_pixel_size() {
    let buffer = TerminalOutputBuffer()
    buffer.append(Data(kitty("a=T,f=32,s=45,v=50,q=2", [UInt8](repeating: 9, count: 45 * 50 * 4)).utf8))
    let placement = buffer.replay(cols: 40, rows: 10, cellPixelSize: (10, 20)).frame().images.placements.first
    XCTAssertEqual(placement?.cols, 5)
    XCTAssertEqual(placement?.rows, 3)
  }

  func test_output_and_scrolling_move_an_image_with_its_text() {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.setCellPixelSize(width: 10, height: 20)
    engine.feed("\r\n\r\n" + kitty("a=T,f=32,s=2,v=2,q=2", redOverBlue))
    XCTAssertEqual(engine.frame().images.placements.first?.row, 2)
    engine.feed(String(repeating: "\r\nline", count: 4))
    XCTAssertEqual(engine.frame().images.placements.first?.row, 0)
    engine.scrollViewport(lines: 2)
    XCTAssertEqual(engine.frame().images.placements.first?.row, 2)
  }

  func test_deleting_the_last_image_on_an_empty_alt_screen_clears_it() throws {
    let renderer = TerminalGridRenderer()
    let cells = [GridSnapshot.Cell](repeating: black, count: 4 * 2)
    _ = renderer.render(
      header: header(cols: 4, rows: 2, altScreen: true), cells: cells,
      images: layer(solidRed, placement(cols: 2, rows: 2)), metrics: metrics(cols: 4, rows: 2)
    )
    let cleared = try XCTUnwrap(renderer.render(
      header: header(cols: 4, rows: 2, altScreen: true, generation: 2), cells: cells,
      images: .empty, metrics: metrics(cols: 4, rows: 2)
    ))
    XCTAssertLessThan(pixel(cleared, x: 5, y: 5).r, 60, "the deleted image is still drawn")
  }

  func test_an_image_under_the_backgrounds_shows_through_unpainted_cells_only() throws {
    var cells = [GridSnapshot.Cell](repeating: black, count: 4 * 2)
    cells[0].attrs = GridSnapshot.attrDefaultBackground      // never painted
    cells[1].background = 0xFF00_FF00                        // painted green
    // cells[2]: painted by a program in exactly the default color: still covers the image.
    let under = layer(solidRed, placement(cols: 3, rows: 1, width: 2, height: 2, depth: .belowBackground))
    let image = try XCTUnwrap(TerminalGridRenderer().render(
      header: header(cols: 4, rows: 2), cells: cells, images: under, metrics: metrics(cols: 4, rows: 2)
    ))
    XCTAssertGreaterThan(pixel(image, x: 5, y: 5).r, 200, "an unpainted cell hides the image")
    let green = pixel(image, x: 25, y: 5)
    XCTAssertGreaterThan(green.g, 200)
    XCTAssertLessThan(green.r, 60)
    XCTAssertLessThan(pixel(image, x: 35, y: 5).r, 60, "a cell painted in the default color went see-through")
  }

  func test_the_engine_marks_which_cells_keep_the_default_background() {
    let engine = TerminalEngine(cols: 10, rows: 1)
    engine.feed("a\u{1B}[41mb\u{1B}[49mc")
    let cells = engine.frame().cells
    XCTAssertNotEqual(cells[0].attrs & GridSnapshot.attrDefaultBackground, 0)
    XCTAssertEqual(cells[1].attrs & GridSnapshot.attrDefaultBackground, 0)
    XCTAssertNotEqual(cells[2].attrs & GridSnapshot.attrDefaultBackground, 0)
  }

  func test_an_animation_advances_without_any_output() async throws {
    let engine = TerminalEngine(cols: 20, rows: 5)
    engine.setCellPixelSize(width: 10, height: 20)
    engine.feed(kitty("a=T,f=32,s=2,v=2,i=9,q=2", solidRed))
    engine.feed(kitty("a=f,i=9,f=32,s=2,v=2,z=20,q=2", solidBlue))
    engine.feed(kitty("a=a,i=9,s=3,z=20,q=2"))
    let first = try XCTUnwrap(engine.frame().images.placements.first?.key)
    var advanced = false
    for _ in 0..<40 where !advanced {
      try await Task.sleep(for: .milliseconds(25))
      advanced = engine.frame().images.placements.first?.key != first
    }
    XCTAssertTrue(advanced, "the animated image never changed")
  }

  func test_a_still_image_is_watched_ever_more_slowly_and_output_speeds_it_up() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 20, rows: 5)
    await pipeline.feedForTest(Data(kitty("a=T,f=32,s=2,v=2,q=2", solidRed).utf8))
    for _ in 0..<6 { await pipeline.imageWatchTickForTest() }
    var delay = await pipeline.imageWatchDelayForTest
    XCTAssertEqual(delay, .seconds(1))
    await pipeline.feedForTest(Data("x".utf8))
    delay = await pipeline.imageWatchDelayForTest
    XCTAssertEqual(delay, .milliseconds(50))
  }

  func test_output_restarts_a_backed_off_watch_at_the_fast_interval() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 20, rows: 5)
    await pipeline.feedForTest(Data(kitty("a=T,f=32,s=2,v=2,q=2", solidRed).utf8))
    for _ in 0..<6 { await pipeline.imageWatchTickForTest() }
    let restartsBefore = await pipeline.imageWatchStartsForTest
    await pipeline.feedForTest(Data("x".utf8))
    let restartsAfter = await pipeline.imageWatchStartsForTest
    XCTAssertEqual(restartsAfter, restartsBefore + 1, "a 1 s sleep already under way was left to run out")
  }

  func test_a_scroll_after_disconnect_does_not_start_watching_again() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 20, rows: 5)
    await pipeline.feedForTest(Data(kitty("a=T,f=32,s=2,v=2,q=2", solidRed).utf8))
    await pipeline.disconnect()
    await pipeline.scrollViewport(lines: 1)
    let watching = await pipeline.isWatchingImagesForTest
    XCTAssertFalse(watching)
  }

  func test_a_connection_that_ends_by_itself_stops_the_image_watch() async throws {
    let pipeline = TerminalPipeline()
    let stream = ClosingByteStream(chunks: [Data(kitty("a=T,f=32,s=2,v=2,q=2", solidRed).utf8)])
    await pipeline.connectSSH(transport: stream, key: "k")
    var watching = true
    for _ in 0..<40 where watching {
      try await Task.sleep(for: .milliseconds(25))
      watching = await pipeline.isWatchingImagesForTest
    }
    XCTAssertFalse(watching, "the watch kept polling after the stream ended")
  }

  func test_disconnecting_stops_the_image_watch() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 20, rows: 5)
    await pipeline.feedForTest(Data(kitty("a=T,f=32,s=2,v=2,q=2", solidRed).utf8))
    await pipeline.disconnect()
    let watching = await pipeline.isWatchingImagesForTest
    XCTAssertFalse(watching)
  }

  func test_the_pipeline_watches_the_frame_only_while_images_are_shown() async {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 20, rows: 5)
    await pipeline.feedForTest(Data(kitty("a=T,f=32,s=2,v=2,q=2", solidRed).utf8))
    var watching = await pipeline.isWatchingImagesForTest
    XCTAssertTrue(watching)
    await pipeline.feedForTest(Data(kitty("a=d,d=A,q=2").utf8))
    watching = await pipeline.isWatchingImagesForTest
    XCTAssertFalse(watching)
  }

  func test_kitty_depths_follow_swiftterms_thresholds() {
    XCTAssertEqual(TerminalImageLayer.Depth(zIndex: 0), .aboveText)
    XCTAssertEqual(TerminalImageLayer.Depth(zIndex: -1), .belowText)
    XCTAssertEqual(TerminalImageLayer.Depth(zIndex: Int32.min / 2), .belowText)
    XCTAssertEqual(TerminalImageLayer.Depth(zIndex: Int32.min / 2 - 1), .belowBackground)
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

/// Yields its chunks, then ends like a closed SSH channel.
private actor ClosingByteStream: TerminalByteStream {
  private var chunks: [Data]
  init(chunks: [Data]) { self.chunks = chunks }
  func read() async throws -> Data? { chunks.isEmpty ? nil : chunks.removeFirst() }
  func write(_ bytes: Data) async throws {}
  func close() async {}
}
