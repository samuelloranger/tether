import Foundation
import UniformTypeIdentifiers

/// `scpSend` holds the whole payload in memory, so a video is measured on disk and turned
/// away before it is read.
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

  /// Formats a TUI like Claude Code attaches from a pasted path; anything else (HEIC from
  /// the camera) is re-encoded as JPEG or it would paste as a bare path.
  static let attachableImageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

  /// The `.jpg` name a photo is re-encoded under, or nil when it can be sent as is.
  public static func jpegName(for name: String) -> String? {
    let url = URL(fileURLWithPath: name)
    guard !attachableImageExtensions.contains(url.pathExtension.lowercased()) else { return nil }
    return url.deletingPathExtension().lastPathComponent + ".jpg"
  }

  static let uploadsResolvedMarker = "__TETHER_UPLOADS_OK__"

  /// Resolves `$HOME` on the host, since the pasted path must be absolute for a TUI in any cwd.
  public static let uploadsDirectoryCommand =
    "mkdir -p \"$HOME/.tether/uploads\" && cd \"$HOME/.tether/uploads\" && pwd && echo \(uploadsResolvedMarker)"

  /// The directory the resolve command printed, or nil when it failed and the cwd should be used.
  /// The marker proves `pwd` ran: stderr is dropped, so a failed `cd` could otherwise leave a
  /// startup line that merely looks like a path.
  public static func uploadsDirectory(fromOutput output: String?) -> String? {
    guard let output else { return nil }
    let lines = output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
    guard let marker = lines.lastIndex(of: uploadsResolvedMarker), marker > 0 else { return nil }
    let path = lines[marker - 1]
    return path.hasPrefix("/") ? path : nil
  }

  public static func remotePath(directory: String?, filename: String) -> String {
    guard let directory, !directory.isEmpty else { return filename }
    return directory.hasSuffix("/") ? directory + filename : "\(directory)/\(filename)"
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
#if canImport(UIKit)
import UIKit
#endif

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
    #if canImport(UIKit)
    if let jpegName = jpegName(for: name), let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) {
      return .ready(name: jpegName, data: jpeg)
    }
    #endif
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
