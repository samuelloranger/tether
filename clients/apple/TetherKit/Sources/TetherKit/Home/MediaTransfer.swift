import Foundation
import UniformTypeIdentifiers

/// Rules for sending something picked out of the photo library.
///
/// `scpSend` holds the whole payload in memory on its way to the host, which is
/// fine for a still and not fine for a long 4K clip. So a video is measured on
/// disk and turned away *before* it is read, rather than after the phone has
/// already tried to hold it.
public enum MediaTransfer {
  /// Generous for a clip off a phone, well short of what a mobile app can hold.
  /// Lifting it means streaming the transfer instead of buffering it.
  public static let byteLimit = 200 * 1024 * 1024

  public static func isVideo(contentTypes: [UTType]) -> Bool {
    contentTypes.contains { $0.conforms(to: .movie) }
  }

  public static func filename(preferredExtension: String?, isVideo: Bool, timestamp: Int) -> String {
    let fallback = isVideo ? "mov" : "jpg"
    let ext = preferredExtension?.isEmpty == false ? preferredExtension! : fallback
    return "\(isVideo ? "video" : "photo")-\(timestamp).\(ext)"
  }

  /// `nil` when it can be sent; otherwise the sentence to show.
  public static func rejectionReason(byteCount: Int) -> String? {
    guard byteCount > byteLimit else { return nil }
    let formatter = ByteCountFormatter()
    formatter.countStyle = .binary
    let size = formatter.string(fromByteCount: Int64(byteCount))
    return "That's \(size) — Tether sends up to 200 MB at a time."
  }
}

#if canImport(UIKit)
import CoreTransferable

/// A clip picked from the library, received as a file rather than as bytes.
/// PhotosUI hands over a temporary file that it deletes as soon as the import
/// closure returns, so this copies it aside and the caller removes the copy.
struct PickedMovie: Transferable {
  let url: URL

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(contentType: .movie) { movie in
      SentTransferredFile(movie.url)
    } importing: { received in
      let copy = FileManager.default.temporaryDirectory
        .appendingPathComponent("tether-\(UUID().uuidString)")
        .appendingPathExtension(received.file.pathExtension)
      try FileManager.default.copyItem(at: received.file, to: copy)
      return PickedMovie(url: copy)
    }
  }
}
#endif
