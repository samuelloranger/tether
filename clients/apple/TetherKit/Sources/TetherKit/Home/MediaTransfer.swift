import Foundation
import UniformTypeIdentifiers

/// Rules for sending something picked out of the photo library. `scpSend` holds
/// the whole payload in memory, so a video is measured on disk and turned away
/// before it is read.
public enum MediaTransfer {
  /// What came back from the library: bytes ready to send, or the sentence to
  /// show. A plain message, not an Error — nothing rethrows it.
  public enum Loaded: Equatable {
    case ready(name: String, data: Data)
    case failed(String)
  }

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

import CoreTransferable
import SwiftUI
import PhotosUI

public extension MediaTransfer {
  private static let unreadableVideoMessage = "Couldn't read that video from the library."

  static func load(_ item: PhotosPickerItem, isVideo: Bool) async -> Loaded {
    let name = filename(
      preferredExtension: item.supportedContentTypes.first?.preferredFilenameExtension,
      isVideo: isVideo,
      timestamp: Int(Date().timeIntervalSince1970))

    if isVideo {
      guard let movie = try? await item.loadTransferable(type: PickedMovie.self) else {
        return .failed(unreadableVideoMessage)
      }
      defer { try? FileManager.default.removeItem(at: movie.url) }
      let keys: Set<URLResourceKey> = [.fileSizeKey]
      let size = (try? movie.url.resourceValues(forKeys: keys).fileSize) ?? 0
      if let reason = rejectionReason(byteCount: size) { return .failed(reason) }
      guard let data = try? Data(contentsOf: movie.url) else {
        return .failed(unreadableVideoMessage)
      }
      return .ready(name: name, data: data)
    }

    guard let data = try? await item.loadTransferable(type: Data.self) else {
      return .failed("Couldn't read that photo from the library.")
    }
    return .ready(name: name, data: data)
  }
}

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
