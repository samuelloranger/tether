import CoreText
import UIKit
import XCTest
@testable import TetherKit

final class GoogleFontsTests: XCTestCase {
  // MARK: - links

  func test_every_link_shape_names_its_family() {
    let cases = [
      "https://fonts.google.com/specimen/Fira+Code": "Fira Code",
      "https://fonts.google.com/specimen/IBM%20Plex%20Mono?query=mono": "IBM Plex Mono",
      "https://fonts.google.com/specimen/VT323/about": "VT323",
      "https://fonts.googleapis.com/css2?family=Victor+Mono:ital,wght@0,400;1,700&display=swap": "Victor Mono",
      "https://fonts.googleapis.com/css?family=Space+Mono|Roboto": "Space Mono",
      "https://fonts.google.com/share?selection.family=Geist+Mono:wght@100..900": "Geist Mono",
      "  Martian   Mono ": "Martian Mono",
    ]
    for (link, family) in cases {
      XCTAssertEqual(GoogleFonts.family(from: link), family, link)
    }
  }

  func test_other_hosts_and_junk_are_refused() {
    for input in ["https://example.com/specimen/Fira+Code", "", "Fira Code; rm -rf ~", "https://fonts.google.com/"] {
      XCTAssertNil(GoogleFonts.family(from: input), input)
    }
  }

  func test_the_css_request_asks_for_regular_and_bold() {
    XCTAssertEqual(
      GoogleFonts.cssURL(family: "Fira Code", weights: true).absoluteString,
      "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700"
    )
    XCTAssertEqual(
      GoogleFonts.cssURL(family: "VT323", weights: false).absoluteString,
      "https://fonts.googleapis.com/css2?family=VT323"
    )
  }

  // MARK: - css

  private let css = """
  @font-face {
    font-family: 'Fira Code';
    font-style: normal;
    font-weight: 400;
    src: url(https://fonts.gstatic.com/s/firacode/v27/regular.ttf) format('truetype');
  }
  @font-face {
    font-family: 'Fira Code';
    font-weight: 700;
    src: url(https://fonts.gstatic.com/s/firacode/v27/bold.ttf) format('truetype');
  }
  @font-face {
    font-weight: 500;
    src: url(https://evil.example/x.ttf) format('truetype');
  }
  @font-face {
    font-weight: 300;
    src: url(https://fonts.gstatic.com/s/firacode/v27/light.woff2) format('woff2');
  }
  """

  func test_only_truetype_faces_from_gstatic_are_taken() {
    XCTAssertEqual(GoogleFonts.faces(css: css).map(\.weight), [400, 700])
  }

  func test_regular_is_the_face_nearest_400_and_bold_is_700() {
    let picked = GoogleFonts.pick(GoogleFonts.faces(css: css))
    XCTAssertEqual(picked?.regular.url.lastPathComponent, "regular.ttf")
    XCTAssertEqual(picked?.bold?.url.lastPathComponent, "bold.ttf")
    let single = GoogleFonts.pick([.init(weight: 300, url: URL(string: "https://fonts.gstatic.com/a.ttf")!)])
    XCTAssertEqual(single?.regular.weight, 300)
    XCTAssertNil(single?.bold)
  }

  func test_monospace_detection_reads_the_advances() {
    XCTAssertTrue(GoogleFontsInstaller.isMonospaced(CTFontCreateWithName("Menlo-Regular" as CFString, 12, nil)))
    XCTAssertFalse(GoogleFontsInstaller.isMonospaced(CTFontCreateWithName("Helvetica" as CFString, 12, nil)))
  }

  // MARK: - install

  /// The face's data, with the bundled copy taken out of Core Text for the test: the
  /// installer rightly refuses a download whose name is already served.
  private func bundled(_ name: String) throws -> Data {
    TerminalFonts.registerBundledFonts()
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "ttf"))
    CTFontManagerUnregisterFontsForURL(url as CFURL, .process, nil)
    addTeardownBlock { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
    return try Data(contentsOf: url)
  }

  /// A stub that serves `css` for the CSS API and `faces[file]` for gstatic files.
  private func stub(css: String, faces: [String: Data], status: Int = 200) -> GoogleFontsInstaller.Fetch {
    { request in
      let url = request.url!
      if url.host == "fonts.googleapis.com" { return (Data(css.utf8), self.response(url, status)) }
      return (faces[url.lastPathComponent] ?? Data(), self.response(url, 200))
    }
  }

  private func response(_ url: URL, _ status: Int) -> URLResponse {
    HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
  }

  private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  func test_install_downloads_both_faces_and_reads_their_names() async throws {
    let regular = try bundled("JetBrainsMono-Regular")
    let bold = try bundled("JetBrainsMono-Bold")
    let css = self.css
    let agents = LockedBox<[String]>([])
    let directory = temporaryDirectory()
    let installer = GoogleFontsInstaller(directory: directory) { request in
      let url = request.url!
      if url.host == "fonts.googleapis.com" {
        agents.value.append(request.value(forHTTPHeaderField: "User-Agent") ?? "")
        return (Data(css.utf8), self.response(url, 200))
      }
      return (url.lastPathComponent == "bold.ttf" ? bold : regular, self.response(url, 200))
    }
    let font = try await installer.install("https://fonts.google.com/specimen/Fira+Code").font
    XCTAssertEqual(font.id, "gf-fira-code")
    XCTAssertEqual(font.postScriptName, "JetBrainsMono-Regular")
    XCTAssertEqual(font.boldPostScriptName, "JetBrainsMono-Bold")
    XCTAssertTrue(font.isMonospaced)
    XCTAssertEqual(agents.value, ["Tether"], "a browser agent would be served WOFF2")
    for file in font.files {
      XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("fira-code/\(file)").path))
    }

    installer.remove(font)
    XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("fira-code").path))
  }

  func test_a_family_without_bold_retries_without_weights() async throws {
    let regular = try bundled("ComicMono")
    let requested = LockedBox<[String]>([])
    let installer = GoogleFontsInstaller(directory: temporaryDirectory()) { request in
      let url = request.url!
      requested.value.append(url.absoluteString)
      if url.absoluteString.contains("wght") { return (Data(), self.response(url, 400)) }
      if url.host == "fonts.googleapis.com" {
        let css = "@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/s/vt/a.ttf) format('truetype'); }"
        return (Data(css.utf8), self.response(url, 200))
      }
      return (regular, self.response(url, 200))
    }
    let font = try await installer.install("VT323").font
    XCTAssertNil(font.boldPostScriptName)
    XCTAssertEqual(font.files, ["regular.ttf"])
    XCTAssertEqual(requested.value.count, 3)
  }

  func test_a_name_core_text_already_serves_is_refused() async throws {
    TerminalFonts.registerBundledFonts()
    let data = try Data(contentsOf: XCTUnwrap(Bundle.module.url(forResource: "JetBrainsMono-Regular", withExtension: "ttf")))
    let directory = temporaryDirectory()
    let installer = GoogleFontsInstaller(directory: directory, fetch: stub(css: css, faces: ["regular.ttf": data, "bold.ttf": data]))
    do {
      _ = try await installer.install("JetBrains Mono")
      XCTFail("installed a copy of a bundled face")
    } catch {
      XCTAssertEqual(error as? GoogleFontsError, .nameTaken("JetBrainsMono-Regular"))
    }
    let left = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    XCTAssertEqual(left, [], "a refused download left files behind")
  }

  func test_a_redirect_off_gstatic_is_refused() async throws {
    let data = try bundled("JetBrainsMono-Regular")
    let installer = GoogleFontsInstaller(directory: temporaryDirectory()) { request in
      let url = request.url!
      if url.host == "fonts.googleapis.com" { return (Data(self.css.utf8), self.response(url, 200)) }
      return (data, self.response(URL(string: "https://evil.example/x.ttf")!, 200))
    }
    do {
      _ = try await installer.install("Fira Code")
      XCTFail("accepted a font from another host")
    } catch {
      XCTAssertEqual(error as? GoogleFontsError, .offHost("evil.example"))
    }
  }

  func test_a_service_error_is_not_reported_as_an_unknown_family() async {
    let installer = GoogleFontsInstaller(directory: temporaryDirectory(), fetch: stub(css: "", faces: [:], status: 503))
    do {
      _ = try await installer.install("Fira Code")
      XCTFail("installed during an outage")
    } catch {
      XCTAssertEqual(error as? GoogleFontsError, .service(status: 503))
    }
  }

  func test_a_re_download_replaces_the_old_files_once_committed() async throws {
    let regular = try bundled("JetBrainsMono-Regular")
    let bold = try bundled("JetBrainsMono-Bold")
    let directory = temporaryDirectory()
    let first = GoogleFontsInstaller(directory: directory, fetch: stub(css: css, faces: ["regular.ttf": regular, "bold.ttf": bold]))
    let installed = try await first.install("Fira Code")
    XCTAssertTrue(first.register(installed.font))
    first.commit(installed)

    let regularOnly = "@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/s/f/regular.ttf) format('truetype'); }"
    let second = GoogleFontsInstaller(directory: directory, fetch: stub(css: regularOnly, faces: ["regular.ttf": regular]))
    let replaced = try await second.install("Fira Code")
    XCTAssertEqual(replaced.font.files, ["regular.ttf"])
    XCTAssertNotNil(replaced.backup, "the replaced files must be kept until the new ones register")
    second.commit(replaced)
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    XCTAssertEqual(files, ["fira-code"], "a backup or staging folder was left behind")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("fira-code").path), ["regular.ttf"])
    second.remove(replaced.font)
  }

  func test_a_rolled_back_re_download_puts_the_previous_files_back() async throws {
    let regular = try bundled("JetBrainsMono-Regular")
    let bold = try bundled("JetBrainsMono-Bold")
    let directory = temporaryDirectory()
    let first = GoogleFontsInstaller(directory: directory, fetch: stub(css: css, faces: ["regular.ttf": regular, "bold.ttf": bold]))
    let original = try await first.install("Fira Code")
    first.commit(original)

    let regularOnly = "@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/s/f/regular.ttf) format('truetype'); }"
    let second = GoogleFontsInstaller(directory: directory, fetch: stub(css: regularOnly, faces: ["regular.ttf": regular]))
    let replaced = try await second.install("Fira Code")
    second.rollback(replaced)
    let folder = directory.appendingPathComponent("fira-code").path
    XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: folder)), ["regular.ttf", "bold.ttf"])
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["fira-code"])
    XCTAssertTrue(first.register(original.font), "the restored files no longer register")
    first.remove(original.font)
  }

  /// Fails the moves `failing` picks, like a full disk or a sandbox refusal would.
  private final class FailingFileManager: FileManager, @unchecked Sendable {
    var failing: (URL, URL) -> Bool = { _, _ in false }
    override func moveItem(at srcURL: URL, to dstURL: URL) throws {
      if failing(srcURL, dstURL) { throw CocoaError(.fileWriteUnknown) }
      try super.moveItem(at: srcURL, to: dstURL)
    }
  }

  private func installTwice(files: FailingFileManager, directory: URL) async throws
    -> (first: GoogleFontsInstaller.Installed, second: GoogleFontsInstaller)
  {
    let regular = try bundled("JetBrainsMono-Regular")
    let bold = try bundled("JetBrainsMono-Bold")
    let first = GoogleFontsInstaller(directory: directory, files: files, fetch: stub(css: css, faces: ["regular.ttf": regular, "bold.ttf": bold]))
    let installed = try await first.install("Fira Code")
    XCTAssertTrue(first.register(installed.font))
    first.commit(installed)
    let regularOnly = "@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/s/f/regular.ttf) format('truetype'); }"
    return (installed, GoogleFontsInstaller(directory: directory, files: files, fetch: stub(css: regularOnly, faces: ["regular.ttf": regular])))
  }

  func test_a_failed_move_into_place_puts_the_previous_family_back_and_serves_it() async throws {
    let files = FailingFileManager()
    let directory = temporaryDirectory()
    let (original, second) = try await installTwice(files: files, directory: directory)
    let folder = directory.appendingPathComponent("fira-code")
    files.failing = { source, destination in source.lastPathComponent.hasPrefix(".fira-code-") && destination == folder && !source.lastPathComponent.contains("-old-") }
    do {
      _ = try await second.install("Fira Code")
      XCTFail("the failing move was not reported")
    } catch {}
    XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: folder.path)), ["regular.ttf", "bold.ttf"])
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["fira-code"])
    XCTAssertNotNil(UIFont(name: original.font.postScriptName, size: 12), "the restored family isn't served")
    second.remove(original.font)
  }

  func test_a_failed_move_aside_keeps_the_previous_family_served() async throws {
    let files = FailingFileManager()
    let directory = temporaryDirectory()
    let (original, second) = try await installTwice(files: files, directory: directory)
    files.failing = { _, destination in destination.lastPathComponent.contains("-old-") }
    do {
      _ = try await second.install("Fira Code")
      XCTFail("the failing move was not reported")
    } catch {}
    XCTAssertNotNil(UIFont(name: original.font.postScriptName, size: 12), "the untouched family is no longer served")
    second.remove(original.font)
  }

  func test_a_rollback_that_cannot_restore_says_so() async throws {
    let files = FailingFileManager()
    let directory = temporaryDirectory()
    let (_, second) = try await installTwice(files: files, directory: directory)
    let replaced = try await second.install("Fira Code")
    files.failing = { source, _ in source.lastPathComponent.contains("-old-") }
    XCTAssertFalse(second.rollback(replaced))
    XCTAssertTrue(
      try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.contains("-old-") },
      "the backup that couldn't move back was deleted"
    )
  }

  // MARK: - launch recovery

  private func record(_ files: [String], name: String = "FiraCode-Regular") -> DownloadedFont {
    DownloadedFont(
      family: "Fira Code", slug: "fira-code", postScriptName: name,
      boldPostScriptName: nil, files: files, isMonospaced: true
    )
  }

  /// A family folder holding `contents`, a backup holding the previous files, and a
  /// journal, as a crash between the swap and commit leaves them.
  private func interrupted(
    in directory: URL, installed: DownloadedFont, previous: DownloadedFont?, withBackup: Bool = true
  ) throws -> URL {
    let folder = directory.appendingPathComponent("fira-code")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: folder.appendingPathComponent("regular.ttf").path, contents: Data("new".utf8))
    var backupName: String?
    if withBackup {
      let backup = directory.appendingPathComponent(".fira-code-old-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: backup.appendingPathComponent("regular.ttf").path, contents: Data("old".utf8))
      backupName = backup.lastPathComponent
    }
    let journal = GoogleFontsInstaller.Journal(installed: installed, previous: previous, backup: backupName)
    try JSONEncoder().encode(journal).write(to: GoogleFontsInstaller.journalURL(slug: "fira-code", in: directory))
    return folder
  }

  private func contents(_ url: URL) -> String? {
    FileManager.default.contents(atPath: url.appendingPathComponent("regular.ttf").path).map { String(decoding: $0, as: UTF8.self) }
  }

  func test_recovery_rolls_back_a_swap_preferences_never_saw() throws {
    let directory = temporaryDirectory()
    // Same file names on both sides: only the journal tells which one preferences hold.
    let old = record(["regular.ttf"], name: "FiraCode-Old")
    let new = record(["regular.ttf"], name: "FiraCode-New")
    let folder = try interrupted(in: directory, installed: new, previous: old)
    let fonts = GoogleFontsInstaller(directory: directory).recoverInterrupted(saved: [old])
    XCTAssertEqual(fonts, [old])
    XCTAssertEqual(contents(folder), "old")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["fira-code"])
  }

  func test_recovery_keeps_a_swap_preferences_already_hold() throws {
    let directory = temporaryDirectory()
    let old = record(["regular.ttf"], name: "FiraCode-Old")
    let new = record(["regular.ttf"], name: "FiraCode-New")
    let folder = try interrupted(in: directory, installed: new, previous: old)
    let fonts = GoogleFontsInstaller(directory: directory).recoverInterrupted(saved: [new])
    XCTAssertEqual(fonts, [new])
    XCTAssertEqual(contents(folder), "new")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["fira-code"])
  }

  func test_recovery_brings_back_a_font_a_failed_restore_dropped() throws {
    let directory = temporaryDirectory()
    let old = record(["regular.ttf"], name: "FiraCode-Old")
    let new = record(["regular.ttf"], name: "FiraCode-New")
    let folder = try interrupted(in: directory, installed: new, previous: old)
    // The failed rollback stopped offering the previous font; its backup and journal stayed.
    let fonts = GoogleFontsInstaller(directory: directory).recoverInterrupted(saved: [])
    XCTAssertEqual(fonts, [old])
    XCTAssertEqual(contents(folder), "old")
  }

  func test_recovery_removes_a_first_install_preferences_never_saw_and_stray_staging() throws {
    let directory = temporaryDirectory()
    _ = try interrupted(in: directory, installed: record(["regular.ttf"]), previous: nil, withBackup: false)
    try FileManager.default.createDirectory(at: directory.appendingPathComponent(".vt323-\(UUID().uuidString)"), withIntermediateDirectories: true)
    let fonts = GoogleFontsInstaller(directory: directory).recoverInterrupted(saved: [])
    XCTAssertEqual(fonts, [])
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
  }

  func test_an_unfinished_replace_blocks_a_retry_instead_of_losing_its_backup() async throws {
    let directory = temporaryDirectory()
    _ = try interrupted(in: directory, installed: record(["regular.ttf"], name: "FiraCode-New"), previous: record(["regular.ttf"], name: "FiraCode-Old"))
    let regular = try bundled("JetBrainsMono-Regular")
    let regularOnly = "@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/s/f/regular.ttf) format('truetype'); }"
    let installer = GoogleFontsInstaller(directory: directory, fetch: stub(css: regularOnly, faces: ["regular.ttf": regular]))
    do {
      _ = try await installer.install("Fira Code")
      XCTFail("a second install ran over the unfinished one")
    } catch {
      XCTAssertEqual(error as? GoogleFontsError, .unfinished("Fira Code"))
    }
    XCTAssertTrue(
      try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.contains("-old-") },
      "the unfinished replace's backup is gone"
    )
  }

  func test_a_committed_install_leaves_no_journal() async throws {
    let regular = try bundled("JetBrainsMono-Regular")
    let directory = temporaryDirectory()
    let regularOnly = "@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/s/f/regular.ttf) format('truetype'); }"
    let installer = GoogleFontsInstaller(directory: directory, fetch: stub(css: regularOnly, faces: ["regular.ttf": regular]))
    let installed = try await installer.install("Fira Code")
    XCTAssertTrue(FileManager.default.fileExists(atPath: installed.journal.path), "no journal while uncommitted")
    installer.commit(installed)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["fira-code"])
    installer.remove(installed.font)
  }

  func test_a_family_whose_files_are_gone_does_not_register() {
    let font = DownloadedFont(
      family: "Gone Mono", slug: "gone-mono", postScriptName: "GoneMono-Regular",
      boldPostScriptName: nil, files: ["regular.ttf"], isMonospaced: true
    )
    XCTAssertFalse(GoogleFontsInstaller(directory: temporaryDirectory()).register(font))
  }

  func test_removing_a_download_never_touches_a_bundled_bold_face() {
    TerminalFonts.setDownloadedBoldFace(nil, for: "JetBrainsMono-Regular")
    XCTAssertEqual(TerminalFonts.boldFace(for: "JetBrainsMono-Regular"), "JetBrainsMono-Bold")
  }

  func test_an_unknown_family_and_a_non_font_file_fail_clearly() async {
    let missing = GoogleFontsInstaller(directory: temporaryDirectory()) { request in
      (Data(), self.response(request.url!, 400))
    }
    do {
      _ = try await missing.install("Nope Mono")
      XCTFail("installed a family that does not exist")
    } catch {
      XCTAssertEqual(error as? GoogleFontsError, .unknownFamily("Nope Mono"))
    }

    let css = self.css
    let garbage = GoogleFontsInstaller(directory: temporaryDirectory()) { request in
      let url = request.url!
      return (url.host == "fonts.googleapis.com" ? Data(css.utf8) : Data("<html>".utf8), self.response(url, 200))
    }
    do {
      _ = try await garbage.install("Fira Code")
      XCTFail("installed a file that is not a font")
    } catch {
      XCTAssertEqual(error as? GoogleFontsError, .unreadable)
    }
  }
}
