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
  case service(status: Int)
  case download(String)
  case unreadable
  case offHost(String)
  case nameTaken(String)
  case busy
  case unfinished(String)

  public var errorDescription: String? {
    switch self {
    case .notALink: return "Paste a fonts.google.com link or a family name."
    case let .unknownFamily(family): return "Google Fonts has no family named “\(family)”."
    case let .service(status): return "Google Fonts answered HTTP \(status); try again later."
    case let .download(reason): return "Download failed: \(reason)"
    case .unreadable: return "The downloaded file isn’t a font this device can use."
    case let .offHost(host): return "The download was redirected to \(host); nothing was installed."
    case let .nameTaken(name): return "A font named “\(name)” is already installed, so this one would never be used."
    case .busy: return "Another font is still downloading."
    case let .unfinished(family): return "An earlier install of “\(family)” didn’t finish; restart Tether to recover it."
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

  /// The folder and id stem for a family: "Fira Code" -> "fira-code".
  public static func slug(_ family: String) -> String {
    family.lowercased().split(separator: " ").joined(separator: "-")
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
/// `@unchecked`: FileManager isn't marked Sendable, but its file operations are safe to call
/// from any thread; tests hand in one that fails on purpose.
public struct GoogleFontsInstaller: @unchecked Sendable {
  public typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)

  let directory: URL
  let fetch: Fetch
  let files: FileManager

  public init(
    directory: URL = GoogleFontsInstaller.defaultDirectory,
    files: FileManager = .default,
    fetch: @escaping Fetch = { try await URLSession.shared.data(for: $0) }
  ) {
    self.directory = directory
    self.files = files
    self.fetch = fetch
  }

  public static var defaultDirectory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Fonts", isDirectory: true)
  }

  /// A family moved into place, with the files it replaced kept aside until the caller
  /// knows the new ones register.
  public struct Installed: Sendable {
    public let font: DownloadedFont
    let backup: URL?
    let journal: URL
  }

  /// Written before the old folder moves aside and removed by `commit` once preferences
  /// hold the new record, so a launch after a crash knows which side of the swap it's on
  /// instead of guessing from which files exist.
  struct Journal: Codable, Equatable {
    var installed: DownloadedFont
    var previous: DownloadedFont?
    /// The backup folder's name, when there was a previous folder to keep aside.
    var backup: String?
  }

  /// Downloads and stores a family without registering it. A re-download replaces the
  /// previous files only once the new ones are complete, and keeps them in a backup until
  /// `commit` or `rollback`.
  /// `previous` is the saved record this download replaces, if any; it is journaled so a
  /// failed or interrupted replace can bring it back.
  public func install(_ input: String, previous: DownloadedFont? = nil) async throws -> Installed {
    guard let family = GoogleFonts.family(from: input) else { throw GoogleFontsError.notALink }
    // A family without a 700 answers the weighted request with 400.
    var css = try await text(GoogleFonts.cssURL(family: family, weights: true))
    if case .missing = css { css = try await text(GoogleFonts.cssURL(family: family, weights: false)) }
    let body: String
    switch css {
    case let .found(text): body = text
    case .missing: throw GoogleFontsError.unknownFamily(family)
    case let .failed(status): throw GoogleFontsError.service(status: status)
    }
    guard let picked = GoogleFonts.pick(GoogleFonts.faces(css: body)) else {
      throw GoogleFontsError.unknownFamily(family)
    }

    let slug = GoogleFonts.slug(family)
    // A journal still here would be overwritten, and its backup lost at the next launch.
    guard !files.fileExists(atPath: Self.journalURL(slug: slug, in: directory).path) else {
      throw GoogleFontsError.unfinished(family)
    }
    let folder = directory.appendingPathComponent(slug, isDirectory: true)
    let staging = directory.appendingPathComponent(".\(slug)-\(UUID().uuidString)", isDirectory: true)
    try files.createDirectory(at: staging, withIntermediateDirectories: true)
    do {
      let regular = try await save(picked.regular, as: "regular", in: staging)
      var bold: SavedFace?
      if let face = picked.bold { bold = try await save(face, as: "bold", in: staging) }
      // Core Text serves one face per PostScript name; a clash with a bundled, system or
      // other downloaded face would leave this one unused.
      for name in [regular.postScriptName] + (bold.map { [$0.postScriptName] } ?? []) {
        if Self.isInstalled(postScriptName: name, outside: folder) { throw GoogleFontsError.nameTaken(name) }
      }
      let font = DownloadedFont(
        family: family, slug: slug,
        postScriptName: regular.postScriptName, boldPostScriptName: bold?.postScriptName,
        files: [regular.file] + (bold.map { [$0.file] } ?? []),
        isMonospaced: regular.isMonospaced
      )
      let hasPrevious = files.fileExists(atPath: folder.path)
      let backup = hasPrevious
        ? directory.appendingPathComponent(".\(slug)-old-\(UUID().uuidString)", isDirectory: true) : nil
      let journal = Self.journalURL(slug: slug, in: directory)
      try JSONEncoder().encode(Journal(installed: font, previous: previous, backup: backup?.lastPathComponent))
        .write(to: journal, options: .atomic)
      if let backup {
        unregisterAll(in: folder)
        do {
          try files.moveItem(at: folder, to: backup)
        } catch {
          // The previous files never moved: serve them again.
          registerAll(in: folder)
          try? files.removeItem(at: journal)
          throw error
        }
      }
      do {
        try files.moveItem(at: staging, to: folder)
      } catch {
        // Put the previous files back rather than leave the family with neither. If that
        // fails too, the journal stays for the next launch to finish the job.
        if let backup {
          if (try? files.moveItem(at: backup, to: folder)) != nil {
            registerAll(in: folder)
            try? files.removeItem(at: journal)
          }
        } else {
          try? files.removeItem(at: journal)
        }
        throw error
      }
      return Installed(font: font, backup: backup, journal: journal)
    } catch {
      try? files.removeItem(at: staging)
      throw error
    }
  }

  /// Preferences now hold the new record: the replaced files and the journal can go.
  public func commit(_ installed: Installed) {
    if let backup = installed.backup { try? files.removeItem(at: backup) }
    try? files.removeItem(at: installed.journal)
  }

  static func journalURL(slug: String, in directory: URL) -> URL {
    directory.appendingPathComponent(".\(slug)-pending.json")
  }

  /// The new files didn't register: remove them and put the replaced ones back. False when
  /// the previous files couldn't be restored; a backup that couldn't move stays on disk for
  /// `recoverInterrupted` at the next launch.
  @discardableResult
  public func rollback(_ installed: Installed) -> Bool {
    let folder = directory.appendingPathComponent(installed.font.slug, isDirectory: true)
    unregisterAll(in: folder)
    TerminalFonts.setDownloadedBoldFace(nil, for: installed.font.postScriptName)
    guard (try? files.removeItem(at: folder)) != nil || !files.fileExists(atPath: folder.path) else { return false }
    if let backup = installed.backup, (try? files.moveItem(at: backup, to: folder)) == nil { return false }
    try? files.removeItem(at: installed.journal)
    return true
  }

  /// Finishes installs a crash or a failed restore left half done, before saved fonts are
  /// registered, and returns the saved list to use. Per journal: when the saved record is
  /// the new font, the swap was committed and its backup goes; otherwise the previous files
  /// come back, and so does their record if it was dropped. Staging folders and backups no
  /// journal claims are removed.
  public func recoverInterrupted(saved: [DownloadedFont]) -> [DownloadedFont] {
    var fonts = saved
    var claimed: Set<String> = []
    let entries = (try? files.contentsOfDirectory(atPath: directory.path)) ?? []
    for entry in entries where entry.hasPrefix(".") && entry.hasSuffix("-pending.json") {
      let url = directory.appendingPathComponent(entry)
      guard let data = files.contents(atPath: url.path),
            let journal = try? JSONDecoder().decode(Journal.self, from: data)
      else {
        try? files.removeItem(at: url)
        continue
      }
      let slug = journal.installed.slug
      let folder = directory.appendingPathComponent(slug, isDirectory: true)
      let backup = journal.backup.map { directory.appendingPathComponent($0, isDirectory: true) }
      if let backup { claimed.insert(backup.lastPathComponent) }
      let committed = fonts.first { $0.slug == slug } == journal.installed
      if committed {
        if let backup { try? files.removeItem(at: backup) }
      } else if let backup, files.fileExists(atPath: backup.path) {
        try? files.removeItem(at: folder)
        guard (try? files.moveItem(at: backup, to: folder)) != nil else { continue }
        if let previous = journal.previous, !fonts.contains(where: { $0.slug == slug }) { fonts.append(previous) }
      } else if journal.previous == nil {
        // A first install that never reached preferences: its files belong to no one.
        try? files.removeItem(at: folder)
      }
      try? files.removeItem(at: url)
    }
    for entry in entries where entry.hasPrefix(".") && !entry.hasSuffix("-pending.json") && !claimed.contains(entry) {
      try? files.removeItem(at: directory.appendingPathComponent(entry, isDirectory: true))
    }
    return fonts
  }

  /// Registers a stored family's files, e.g. at launch. False when a file is gone or Core
  /// Text refuses it, so the caller can stop offering the font.
  @discardableResult
  public func register(_ font: DownloadedFont) -> Bool {
    let folder = directory.appendingPathComponent(font.slug, isDirectory: true)
    var ok = true
    for file in font.files {
      let url = folder.appendingPathComponent(file)
      guard files.fileExists(atPath: url.path) else { ok = false; continue }
      var error: Unmanaged<CFError>?
      if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
        let code = error.map { CFErrorGetCode($0.takeRetainedValue()) } ?? 0
        if code != CTFontManagerError.alreadyRegistered.rawValue { ok = false }
      }
    }
    guard ok else {
      unregisterAll(in: folder)
      return false
    }
    TerminalFonts.setDownloadedBoldFace(font.boldPostScriptName, for: font.postScriptName)
    return true
  }

  public func remove(_ font: DownloadedFont) {
    let folder = directory.appendingPathComponent(font.slug, isDirectory: true)
    unregisterAll(in: folder)
    try? files.removeItem(at: folder)
    TerminalFonts.setDownloadedBoldFace(nil, for: font.postScriptName)
  }

  private func registerAll(in folder: URL) {
    let urls = (try? files.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    for url in urls { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
  }

  private func unregisterAll(in folder: URL) {
    let files = (try? files.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    for url in files {
      CTFontManagerUnregisterFontsForURL(url as CFURL, .process, nil)
    }
  }

  /// A face by that name that Core Text already serves from somewhere other than `folder`.
  static func isInstalled(postScriptName name: String, outside folder: URL) -> Bool {
    let font = CTFontCreateWithName(name as CFString, 12, nil)
    // An unknown name resolves to a fallback face with a different name.
    guard CTFontCopyPostScriptName(font) as String == name else { return false }
    guard let url = CTFontCopyAttribute(font, kCTFontURLAttribute) as? URL else { return true }
    return !url.standardizedFileURL.path.hasPrefix(folder.standardizedFileURL.path + "/")
  }

  private enum CSS {
    case found(String)
    case missing
    case failed(status: Int)
  }

  private func text(_ url: URL) async throws -> CSS {
    var request = URLRequest(url: url)
    // A browser user agent gets WOFF2; anything else gets TrueType, which Core Text reads.
    request.setValue("Tether", forHTTPHeaderField: "User-Agent")
    let (data, response) = try await load(request, host: "fonts.googleapis.com")
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    switch status {
    case 200: return String(data: data, encoding: .utf8).map(CSS.found) ?? .failed(status: status)
    case 400, 404: return .missing
    default: return .failed(status: status)
    }
  }

  private typealias SavedFace = (file: String, postScriptName: String, isMonospaced: Bool)

  private func save(_ face: GoogleFonts.Face, as name: String, in folder: URL) async throws -> SavedFace {
    let (data, response) = try await load(URLRequest(url: face.url), host: "fonts.gstatic.com")
    guard (response as? HTTPURLResponse)?.statusCode == 200,
          let descriptor = (CTFontManagerCreateFontDescriptorsFromData(data as CFData) as? [CTFontDescriptor])?.first,
          let postScriptName = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String
    else { throw GoogleFontsError.unreadable }
    let ext = ["ttf", "otf"].contains(face.url.pathExtension.lowercased()) ? face.url.pathExtension.lowercased() : "ttf"
    let file = "\(name).\(ext)"
    try data.write(to: folder.appendingPathComponent(file), options: .atomic)
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

  /// The allow-list is checked on the URL the data finally came from, after redirects.
  private func load(_ request: URLRequest, host: String) async throws -> (Data, URLResponse) {
    let result: (Data, URLResponse)
    do { result = try await fetch(request) }
    catch { throw GoogleFontsError.download(error.localizedDescription) }
    let final = result.1.url ?? request.url
    guard final?.scheme == "https", final?.host == host else {
      throw GoogleFontsError.offHost(final?.host ?? "an unknown host")
    }
    return result
  }
}
