import UniformTypeIdentifiers
import XCTest
@testable import TetherKit

/// A transfer is held in memory on its way to `scp`, so a video is turned away
/// by size before it is loaded.
final class MediaTransferTests: XCTestCase {
  func test_a_still_is_named_as_a_photo_and_a_clip_as_a_video() {
    XCTAssertEqual(
      MediaTransfer.filename(preferredExtension: "heic", isVideo: false, timestamp: 1_790_044_951),
      "photo-1790044951.heic")
    XCTAssertEqual(
      MediaTransfer.filename(preferredExtension: "mov", isVideo: true, timestamp: 1_790_044_951),
      "video-1790044951.mov")
  }

  func test_a_missing_extension_falls_back_per_kind() {
    XCTAssertEqual(MediaTransfer.filename(preferredExtension: nil, isVideo: false, timestamp: 7), "photo-7.jpg")
    XCTAssertEqual(MediaTransfer.filename(preferredExtension: nil, isVideo: true, timestamp: 7), "video-7.mov")
  }

  func test_movies_are_recognised_by_conformance_not_by_a_list_of_extensions() {
    XCTAssertTrue(MediaTransfer.isVideo(contentTypes: [.quickTimeMovie]))
    XCTAssertTrue(MediaTransfer.isVideo(contentTypes: [.mpeg4Movie, .movie]))
    XCTAssertFalse(MediaTransfer.isVideo(contentTypes: [.heic, .jpeg]))
    XCTAssertFalse(MediaTransfer.isVideo(contentTypes: []))
  }

  func test_a_transfer_within_the_limit_is_accepted() {
    XCTAssertNil(MediaTransfer.rejectionReason(byteCount: 8_000_000))
    XCTAssertNil(MediaTransfer.rejectionReason(byteCount: MediaTransfer.byteLimit))
  }

  func test_an_oversized_transfer_is_refused_with_both_numbers() {
    let reason = MediaTransfer.rejectionReason(byteCount: MediaTransfer.byteLimit + 1)
    XCTAssertNotNil(reason)
    XCTAssertTrue(reason!.contains("200 MB"), "missing the limit: \(reason!)")
  }
}
