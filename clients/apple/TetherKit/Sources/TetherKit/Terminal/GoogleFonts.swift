import CoreText
import Foundation

/// A Google Fonts family the user downloaded. Files live in Application Support.
public struct DownloadedFont: Codable, Hashable, Identifiable, Sendable {
  public var id: String { "gf-\(slug)" }
  public var family: String
  public var slug: String
  public var postScriptName: String
  public var boldPostScriptName: String?
  /// File names inside the family's directory.
  public var files: [String]
  public var isMonospaced: Bool

  var terminalFont: TerminalFont {
    TerminalFont(
      id: id, label: family, postScriptName: postScriptName,
      boldPostScriptName: boldPostScriptName, source: .downloaded
    )
  }
}

public enum GoogleFontsError: LocalizedError, Equatable {
  case notALink
  case unknownFamily(String)
  case download(String)
  case unreadable

  public var errorDescription: String? {
    switch self {
    case .notALink: return "Paste a fonts.google.com link or a family name."
    case let .unknownFamily(family): return "Google Fonts has no family named “\(family)”."
    case let .download(reason): return "Download failed: \(reason)"
    case .unreadable: return "The downloaded file isn’t a font this device can use."
    }
  }
}

public enum GoogleFonts {
  /// Monospace families on Google Fonts, offered as one-tap suggestions.
  public static let suggestions = [
    "Fira Code", "IBM Plex Mono", "Source Code Pro", "Victor Mono", "Cascadia Code",
    "Geist Mono", "Martian Mono", "Intel One Mono", "Space Mono", "Kode Mono",
    "Roboto Mono", "Inconsolata", "Ubuntu Mono", "DM Mono", "Red Hat Mono",
    "Fragment Mono", "Azeret Mono", "Major Mono Display", "Xanh Mono", "Syne Mono",
    "VT323", "Share Tech Mono",
  ]

  /// The family a pasted link or name refers to:
  /// `fonts.google.com/specimen/Fira+Code`, `fonts.googleapis.com/css2?family=Fira+Code:wght@400`,
  /// `fonts.google.com/share?selection.family=…`, or just `Fira Code`.
  public static func family(from input: String) -> String? {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if let components = URLComponents(string: trimmed), let host = components.host?.lowercased() {
      let raw: String?
      switch host {
      case "fonts.google.com":
        if components.path.hasPrefix("/specimen/") {
          raw = components.path.dropFirst("/specimen/".count).split(separator: "/").first.map(String.init)
        } else {
          raw = components.queryItems?.first { $0.name == "selection.family" }?.value
        }
      case "fonts.googleapis.com":
        raw = components.queryItems?.first { $0.name == "family" }?.value
      default:
        return nil
      }
      return raw.flatMap(cleanFamily)
    }
    return cleanFamily(trimmed)
  }

  /// `Fira+Code:wght@400;700|Roboto` → `Fira Code`.
  private static func cleanFamily(_ raw: String) -> String? {
    let first = raw.split(separator: "|").first.map(String.init) ?? raw
    let name = (first.split(separator: ":").first.map(String.init) ?? first)
      .replacingOccurrences(of: "+", with: " ")
    let decoded = (name.removingPercentEncoding ?? name)
      .split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: " "))
    guard !decoded.isEmpty, decoded.count <= 64,
          decoded.unicodeScalars.allSatisfy(allowed.contains)
    else { return nil }
    return decoded
  }

  static func cssURL(family: String, weights: Bool) -> URL {
    var components = URLComponents(string: "https://fonts.googleapis.com/css2")!
    components.queryItems = [URLQueryItem(name: "family", value: family + (weights ? ":wght@400;700" : ""))]
    // Google wants `+` for spaces; URLComponents would write %20.
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "%20", with: "+")
    return components.url!
  }

  struct Face: Equatable {
    var weight: Int
    var url: URL
  }

  /// `@font-face` blocks with a TrueType/OpenType source on fonts.gstatic.com. Nothing else
  /// is downloaded: the CSS is text off the network.
  static func faces(css: String) -> [Face] {
    css.components(separatedBy: "@font-face").compactMap { block in
      guard let weightLine = block.range(of: #"font-weight:\s*(\d+)"#, options: .regularExpression),
            let urlRange = block.range(of: #"url\((https://fonts\.gstatic\.com/[^)\s]+)\)\s*format\('(truetype|opentype)'\)"#, options: .regularExpression)
      else { return nil }
      let weight = Int(block[weightLine].filter(\.isNumber)) ?? 400
      let src = block[urlRange]
      guard let open = src.firstIndex(of: "("), let close = src.firstIndex(of: ")"),
            let url = URL(string: String(src[src.index(after: open)..<close]))
      else { return nil }
      return Face(weight: weight, url: url)
    }
  }

  /// The face closest to 400, and a 700 if the family has one.
  static func pick(_ faces: [Face]) -> (regular: Face, bold: Face?)? {
    guard let regular = faces.min(by: { abs($0.weight - 400) < abs($1.weight - 400) }) else { return nil }
    let bold = faces.first { $0.weight == 700 && $0.url != regular.url }
    return (regular, bold)
  }
}

/// Downloads a family's regular and bold faces, stores them, and registers them.
public struct GoogleFontsInstaller: Sendable {
  public typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)

  let directory: URL
  let fetch: Fetch

  public init(
    directory: URL = GoogleFontsInstaller.defaultDirectory,
    fetch: @escaping Fetch = { try await URLSession.shared.data(for: $0) }
  ) {
    self.directory = directory
    self.fetch = fetch
  }

  public static var defaultDirectory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Fonts", isDirectory: true)
  }

  public func install(_ input: String) async throws -> DownloadedFont {
    guard let family = GoogleFonts.family(from: input) else { throw GoogleFontsError.notALink }
    // A family without a 700 answers the weighted request with 400.
    var css = try await text(GoogleFonts.cssURL(family: family, weights: true))
    if css == nil { css = try await text(GoogleFonts.cssURL(family: family, weights: false)) }
    guard let css, let picked = GoogleFonts.pick(GoogleFonts.faces(css: css)) else {
      throw GoogleFontsError.unknownFamily(family)
    }

    let slug = family.lowercased().split(separator: " ").joined(separator: "-")
    let folder = directory.appendingPathComponent(slug, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

    let regular = try await save(picked.regular, as: "regular", in: folder)
    var bold: (file: String, postScriptName: String, isMonospaced: Bool)?
    if let face = picked.bold { bold = try await save(face, as: "bold", in: folder) }
    return DownloadedFont(
      family: family, slug: slug,
      postScriptName: regular.postScriptName, boldPostScriptName: bold?.postScriptName,
      files: [regular.file] + (bold.map { [$0.file] } ?? []),
      isMonospaced: regular.isMonospaced
    )
  }

  /// Registers a stored family's files, e.g. at launch.
  public func register(_ font: DownloadedFont) {
    for file in font.files {
      let url = directory.appendingPathComponent(font.slug).appendingPathComponent(file)
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
    TerminalFonts.setBoldFace(font.boldPostScriptName, for: font.postScriptName)
  }

  public func remove(_ font: DownloadedFont) {
    let folder = directory.appendingPathComponent(font.slug, isDirectory: true)
    for file in font.files {
      CTFontManagerUnregisterFontsForURL(folder.appendingPathComponent(file) as CFURL, .process, nil)
    }
    try? FileManager.default.removeItem(at: folder)
    TerminalFonts.setBoldFace(nil, for: font.postScriptName)
  }

  private func text(_ url: URL) async throws -> String? {
    var request = URLRequest(url: url)
    // A browser user agent gets WOFF2; anything else gets TrueType, which Core Text reads.
    request.setValue("Tether", forHTTPHeaderField: "User-Agent")
    let (data, response) = try await load(request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func save(_ face: GoogleFonts.Face, as name: String, in folder: URL) async throws
    -> (file: String, postScriptName: String, isMonospaced: Bool)
  {
    let (data, response) = try await load(URLRequest(url: face.url))
    guard (response as? HTTPURLResponse)?.statusCode == 200,
          let descriptor = (CTFontManagerCreateFontDescriptorsFromData(data as CFData) as? [CTFontDescriptor])?.first,
          let postScriptName = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String
    else { throw GoogleFontsError.unreadable }
    let ext = face.url.pathExtension.isEmpty ? "ttf" : face.url.pathExtension
    let file = "\(name).\(ext)"
    let url = folder.appendingPathComponent(file)
    try data.write(to: url, options: .atomic)
    CTFontManagerUnregisterFontsForURL(url as CFURL, .process, nil)
    CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    return (file, postScriptName, Self.isMonospaced(CTFontCreateWithFontDescriptor(descriptor, 12, nil)))
  }

  /// Many monospace families don't set the fixed-pitch flag, so compare advances too.
  static func isMonospaced(_ font: CTFont) -> Bool {
    if CTFontGetSymbolicTraits(font).contains(.traitMonoSpace) { return true }
    var characters = Array("iMW.".utf16)
    var glyphs = [CGGlyph](repeating: 0, count: characters.count)
    guard CTFontGetGlyphsForCharacters(font, &characters, &glyphs, characters.count) else { return false }
    var advances = [CGSize](repeating: .zero, count: glyphs.count)
    CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &advances, glyphs.count)
    return Set(advances.map { ($0.width * 100).rounded() }).count == 1
  }

  private func load(_ request: URLRequest) async throws -> (Data, URLResponse) {
    do { return try await fetch(request) }
    catch { throw GoogleFontsError.download(error.localizedDescription) }
  }
}
