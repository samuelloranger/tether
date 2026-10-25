import CoreGraphics
import Foundation
import ImageIO

struct ChatImageAttachment: Equatable, Sendable {
  var mimeType: String
  /// Base64 of the encoded image.
  var data: String
}

enum ChatImageError: Error, Equatable {
  case notAnImage
  case encodingFailed
  case tooLarge(bytes: Int)
}

enum ChatImageEncoder {
  static let maxEdge = 1568
  static let maxEncodedBytes = 5 * 1024 * 1024
  static let jpegQuality = 0.8

  static func encode(
    _ data: Data, maxEdge: Int = maxEdge, quality: Double = jpegQuality, maxBytes: Int = maxEncodedBytes
  ) throws -> ChatImageAttachment {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0
    else { throw ChatImageError.notAnImage }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: min(maxEdge, max(width, height)),
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      throw ChatImageError.notAnImage
    }
    let (mime, pixels) = try render(image, quality: quality)
    guard let encoded = pixels else { throw ChatImageError.encodingFailed }
    guard encoded.count <= maxBytes else { throw ChatImageError.tooLarge(bytes: encoded.count) }
    return ChatImageAttachment(mimeType: mime, data: encoded.base64EncodedString())
  }

  private static func render(_ image: CGImage, quality: Double) throws -> (String, Data?) {
    let width = image.width
    let height = image.height
    let space = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw ChatImageError.encodingFailed }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let base = context.data else { throw ChatImageError.encodingFailed }
    let bytes = base.assumingMemoryBound(to: UInt8.self)
    var translucent = false
    if image.alphaInfo != .none && image.alphaInfo != .noneSkipFirst && image.alphaInfo != .noneSkipLast {
      var index = 3
      let end = width * height * 4
      while index < end {
        if bytes[index] != 255 {
          translucent = true
          break
        }
        index += 4
      }
    }
    if translucent {
      guard let rendered = context.makeImage() else { throw ChatImageError.encodingFailed }
      return ("image/png", write(rendered, type: "public.png", quality: nil))
    }
    guard let flat = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { throw ChatImageError.encodingFailed }
    flat.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    flat.fill(CGRect(x: 0, y: 0, width: width, height: height))
    flat.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let rendered = flat.makeImage() else { throw ChatImageError.encodingFailed }
    return ("image/jpeg", write(rendered, type: "public.jpeg", quality: quality))
  }

  private static func write(_ image: CGImage, type: String, quality: Double?) -> Data? {
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, type as CFString, 1, nil) else { return nil }
    var options: [CFString: Any] = [:]
    if let quality { options[kCGImageDestinationLossyCompressionQuality] = quality }
    CGImageDestinationAddImage(destination, image, options as CFDictionary)
    return CGImageDestinationFinalize(destination) ? output as Data : nil
  }
}
