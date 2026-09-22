import Foundation
import UniformTypeIdentifiers

/// Rules for sending something picked out of the photo library. `scpSend` holds
/// the whole payload in memory, so a video is measured on disk and turned away
/// before it is read.
public enum MediaTransfer {
  /// Lifting this means streaming the transfer instead of buffering it.
  public static let byteLimit = 200 * 1024 * 1024

  public static func isVideo(contentTypes: [UTType]) -> Bool {
    contentTypes.contains { $0.conforms(to: .movie) }
  }

  public static func filename(preferredExtension: String?, isVideo: Bool, timestamp: Int) -> String {
    let fallback = isVideo ? "mov" : "jpg"
    let ext = preferredExtension.flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    return "\(isVideo ? "video" : "photo")-\(timestamp).\(ext)"
  }

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

/// PhotosUI deletes its temporary file as soon as the importer returns, so this
/// copies it aside; the caller removes the copy.
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
