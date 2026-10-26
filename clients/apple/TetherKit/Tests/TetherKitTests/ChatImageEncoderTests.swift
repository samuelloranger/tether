import CoreGraphics
import ImageIO
import XCTest
@testable import TetherKit

final class ChatImageEncoderTests: XCTestCase {
  private func bitmap(width: Int, height: Int, translucent: Bool = false, type: String = "public.png") throws -> Data {
    let context = try XCTUnwrap(CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    for x in stride(from: 0, to: width, by: 8) {
      context.setFillColor(CGColor(red: CGFloat(x % 255) / 255, green: 0.4, blue: 0.7, alpha: 1))
      context.fill(CGRect(x: x, y: 0, width: 8, height: height))
    }
    if translucent {
      context.setBlendMode(.clear)
      context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))
    }
    let image = try XCTUnwrap(context.makeImage())
    let output = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, type as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return output as Data
  }

  private func size(of attachment: ChatImageAttachment) throws -> (Int, Int) {
    let data = try XCTUnwrap(Data(base64Encoded: attachment.data))
    let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
    let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    return (properties[kCGImagePropertyPixelWidth] as? Int ?? 0, properties[kCGImagePropertyPixelHeight] as? Int ?? 0)
  }

  func test_a_large_image_is_scaled_to_the_long_edge_cap_and_becomes_a_jpeg() throws {
    let attachment = try ChatImageEncoder.encode(try bitmap(width: 3136, height: 1568))
    XCTAssertEqual(attachment.mimeType, "image/jpeg")
    let (width, height) = try size(of: attachment)
    XCTAssertEqual(max(width, height), 1568)
    XCTAssertEqual(height, 784)
  }

  func test_a_small_image_keeps_its_size() throws {
    let attachment = try ChatImageEncoder.encode(try bitmap(width: 200, height: 120))
    let (width, height) = try size(of: attachment)
    XCTAssertEqual(width, 200)
    XCTAssertEqual(height, 120)
    XCTAssertEqual(attachment.mimeType, "image/jpeg")
  }

  func test_meaningful_alpha_stays_png_and_an_opaque_png_becomes_jpeg() throws {
    let translucent = try ChatImageEncoder.encode(try bitmap(width: 64, height: 64, translucent: true))
    XCTAssertEqual(translucent.mimeType, "image/png")
    let opaque = try ChatImageEncoder.encode(try bitmap(width: 64, height: 64))
    XCTAssertEqual(opaque.mimeType, "image/jpeg")
  }

  func test_garbage_and_empty_data_are_refused() {
    XCTAssertThrowsError(try ChatImageEncoder.encode(Data("not an image".utf8))) {
      XCTAssertEqual($0 as? ChatImageError, .notAnImage)
    }
    XCTAssertThrowsError(try ChatImageEncoder.encode(Data())) {
      XCTAssertEqual($0 as? ChatImageError, .notAnImage)
    }
  }

  func test_an_image_over_the_byte_cap_after_encoding_is_refused() throws {
    let data = try bitmap(width: 400, height: 400)
    XCTAssertThrowsError(try ChatImageEncoder.encode(data, maxBytes: 10)) {
      guard case let .tooLarge(bytes)? = $0 as? ChatImageError else { return XCTFail() }
      XCTAssertGreaterThan(bytes, 10)
    }
  }
}
