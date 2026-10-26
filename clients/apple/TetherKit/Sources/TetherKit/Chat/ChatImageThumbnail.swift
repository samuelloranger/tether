import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import UIKit

/// Downsampled decoding: a row never holds a full-resolution bitmap, whatever the file's size.
enum ChatImageThumbnail {
  static let rowMaxPixel = 1200
  static let viewerMaxPixel = 3072
  static let chipMaxPixel = 168

  static func options(maxPixel: Int) -> [CFString: Any] {
    [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
  }

  static func make(url: URL, maxPixel: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) > 0
    else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options(maxPixel: maxPixel) as CFDictionary)
  }
}

/// Thumbnails decoded off the main actor and kept by id and size; the cache is cheap to lose.
final class ChatImageLoader: @unchecked Sendable {
  private let cache = NSCache<NSString, UIImage>()

  init() {
    cache.countLimit = 80
    cache.totalCostLimit = 96 * 1024 * 1024
  }

  private func key(_ id: String, _ maxPixel: Int) -> NSString { "\(id)@\(maxPixel)" as NSString }

  func cached(_ id: String, maxPixel: Int) -> UIImage? { cache.object(forKey: key(id, maxPixel)) }

  func load(_ ref: ChatImageRef, from store: ChatImageStore, maxPixel: Int) async -> UIImage? {
    if let hit = cached(ref.id, maxPixel: maxPixel) { return hit }
    let url = store.url(for: ref)
    let image = await Task.detached(priority: .userInitiated) {
      ChatImageThumbnail.make(url: url, maxPixel: maxPixel).map { UIImage(cgImage: $0) }
    }.value
    if let image {
      cache.setObject(image, forKey: key(ref.id, maxPixel), cost: Int(image.size.width * image.size.height * 4))
    }
    return image
  }
}

/// What the rows need to show a chat's images; absent in previews, where every image is a placeholder.
final class ChatImageLibrary: @unchecked Sendable {
  let store: ChatImageStore
  let loader = ChatImageLoader()

  init(store: ChatImageStore) { self.store = store }
}

private struct ChatImagesKey: EnvironmentKey {
  static let defaultValue: ChatImageLibrary? = nil
}

extension EnvironmentValues {
  var chatImages: ChatImageLibrary? {
    get { self[ChatImagesKey.self] }
    set { self[ChatImagesKey.self] = newValue }
  }
}
