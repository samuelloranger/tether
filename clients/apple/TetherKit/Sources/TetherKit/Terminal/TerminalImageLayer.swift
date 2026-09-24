import Foundation
import SwiftTerm

/// Kitty graphics placed on the visible screen, as the renderer draws them.
public struct TerminalImageLayer: Sendable, Equatable {
  /// An image id plus its content generation: a retransmitted image gets a new key.
  public struct Key: Hashable, Sendable {
    public var id: UInt32
    public var generation: UInt64
  }

  /// Straight (non-premultiplied) RGBA, 8 bits per channel.
  public struct Bitmap: Sendable {
    public var width: Int
    public var height: Int
    public var rgba: [UInt8]
  }

  public struct Placement: Equatable, Sendable {
    public var key: Key
    /// Source rectangle in image pixels.
    public var sourceX, sourceY, sourceWidth, sourceHeight: Int
    /// Cell box on the viewport; `row` is negative once the top has scrolled off.
    public var col, row, cols, rows: Int
    /// Offset inside the first cell, in the pixels reported to the program.
    public var offsetX, offsetY: Int
    /// z-index >= 0 draws over text, below 0 under it.
    public var aboveText: Bool
  }

  public var bitmaps: [Key: Bitmap]
  public var placements: [Placement]

  public static let empty = TerminalImageLayer(bitmaps: [:], placements: [])

  public var isEmpty: Bool { placements.isEmpty }

  init(bitmaps: [Key: Bitmap], placements: [Placement]) {
    self.bitmaps = bitmaps
    self.placements = placements
  }

  /// Virtual placements (Unicode placeholders) are skipped: the grid would have to draw
  /// them cell by cell.
  init(_ snapshot: KittyGraphicsRenderSnapshot) {
    var bitmaps: [Key: Bitmap] = [:]
    var placements: [Placement] = []
    for placement in snapshot.placements where !placement.isVirtual {
      guard let image = snapshot.imagesById[placement.imageId] else { continue }
      let key = Key(id: image.imageId, generation: image.contentGeneration)
      if bitmaps[key] == nil {
        bitmaps[key] = Bitmap(width: image.width, height: image.height, rgba: image.rgba)
      }
      let source = placement.visibleSource
      let cells = placement.geometry
      placements.append(Placement(
        key: key,
        sourceX: source.x, sourceY: source.y, sourceWidth: source.width, sourceHeight: source.height,
        col: cells.column, row: cells.row, cols: cells.columns, rows: cells.rows,
        offsetX: placement.pixelOffsetX, offsetY: placement.pixelOffsetY,
        aboveText: placement.zIndex >= 0
      ))
    }
    self.init(bitmaps: bitmaps, placements: placements)
  }

  /// Pixels are never compared: a key changes whenever an image's content does.
  public static func == (lhs: TerminalImageLayer, rhs: TerminalImageLayer) -> Bool {
    lhs.placements == rhs.placements && Set(lhs.bitmaps.keys) == Set(rhs.bitmaps.keys)
  }
}
