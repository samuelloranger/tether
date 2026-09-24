import CoreText
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

  private func bundled(_ name: String) throws -> Data {
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "ttf"))
    return try Data(contentsOf: url)
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
    let font = try await installer.install("https://fonts.google.com/specimen/Fira+Code")
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
    let font = try await installer.install("VT323")
    XCTAssertNil(font.boldPostScriptName)
    XCTAssertEqual(font.files, ["regular.ttf"])
    XCTAssertEqual(requested.value.count, 3)
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
