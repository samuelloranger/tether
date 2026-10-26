import UIKit
import XCTest
@testable import TetherKit

enum TestImages {
  static func render(_ width: Int, _ height: Int, hue: CGFloat = 0.5) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
      UIColor(hue: hue, saturation: 0.6, brightness: 0.9, alpha: 1).setFill()
      context.fill(CGRect(x: 0, y: 0, width: width, height: height))
      UIColor.white.setFill()
      context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))
    }
  }

  static func png(_ width: Int = 8, _ height: Int = 6, hue: CGFloat = 0.5) -> Data { render(width, height, hue: hue).pngData()! }
  static func jpeg(_ width: Int = 8, _ height: Int = 6, hue: CGFloat = 0.5) -> Data {
    render(width, height, hue: hue).jpegData(compressionQuality: 0.8)!
  }

  static func tempFiles() -> (ChatLocalFiles, URL) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("chatimages-\(UUID().uuidString)")
    return (ChatLocalFiles(directory: root.appendingPathComponent("host", isDirectory: true)), root)
  }

  static func update(_ body: [String: Any]) -> String {
    let object: [String: Any] = ["jsonrpc": "2.0", "method": "session/update", "params": ["update": body]]
    return String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
  }

  /// The adapter's completed Read of an image: content, raw output and metadata all carry the picture.
  static func readResult(_ data: Data, id: String = "r1") -> String {
    let b64 = data.base64EncodedString()
    return update([
      "sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed", "title": "Read pic.png",
      "content": [["type": "content", "content": ["type": "image", "data": b64, "mimeType": "image/png"]]],
      "rawOutput": [["type": "image", "source": ["type": "base64", "data": b64, "media_type": "image/png"]]],
      "_meta": ["claudeCode": [
        "toolName": "Read",
        "toolResponse": ["type": "image", "file": ["base64": b64, "type": "image/png", "originalSize": data.count]],
      ]],
    ])
  }

  static func agentImage(_ data: Data, mime: String? = "image/png", messageId: String = "m1") -> String {
    var block: [String: Any] = ["type": "image", "data": data.base64EncodedString()]
    if let mime { block["mimeType"] = mime }
    return update(["sessionUpdate": "agent_message_chunk", "messageId": messageId, "content": block])
  }

  static func text(_ text: String, messageId: String = "m1") -> String {
    update(["sessionUpdate": "agent_message_chunk", "messageId": messageId, "content": ["type": "text", "text": text]])
  }
}

final class ChatImageDecodingTests: XCTestCase {
  private func decode(_ line: String, _ sink: (any ChatImageSink)? = nil) -> ACPInbound {
    ACPDecoder.decode(Data(line.utf8), images: sink)
  }

  func test_a_read_of_an_image_yields_a_reference_and_no_raw_output() {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = files.images("c")
    let png = TestImages.png(8, 6)
    guard case let .update(.toolCallUpdate(fields)) = decode(TestImages.readResult(png), store) else {
      return XCTFail("not a tool update")
    }
    XCTAssertEqual(fields.images?.count, 1)
    let ref = fields.images![0]
    XCTAssertEqual(ref.mimeType, "image/png")
    XCTAssertEqual(ref.pixelWidth, 8)
    XCTAssertEqual(ref.pixelHeight, 6)
    XCTAssertEqual(ref.byteCount, png.count)
    XCTAssertNil(fields.rawOutput)
    XCTAssertNil(fields.text)
    XCTAssertEqual(try Data(contentsOf: store.url(for: ref)), png)
  }

  func test_the_reference_is_the_same_with_or_without_a_store() {
    let png = TestImages.png()
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    XCTAssertEqual(decode(TestImages.readResult(png)), decode(TestImages.readResult(png), files.images("c")))
  }

  func test_a_missing_mime_type_is_sniffed_from_the_bytes() {
    for (data, mime) in [(TestImages.png(), "image/png"), (TestImages.jpeg(), "image/jpeg")] {
      guard case let .update(.agentImage(ref, _)) = decode(TestImages.agentImage(data, mime: nil)) else {
        return XCTFail(mime)
      }
      XCTAssertEqual(ref.mimeType, mime)
    }
    XCTAssertEqual(ChatImageIntake.sniff(Data("GIF89a".utf8) + Data(count: 10)), "image/gif")
    XCTAssertEqual(ChatImageIntake.sniff(Data("RIFF".utf8) + Data(count: 4) + Data("WEBPVP8 ".utf8)), "image/webp")
    XCTAssertEqual(ChatImageIntake.sniff(Data(count: 4) + Data("ftypheic".utf8)), "image/heic")
    XCTAssertNil(ChatImageIntake.sniff(Data("hello world".utf8)))
  }

  func test_a_wrong_declared_type_loses_to_the_bytes() {
    guard case let .update(.agentImage(ref, _)) = decode(TestImages.agentImage(TestImages.jpeg(), mime: "image/png")) else {
      return XCTFail()
    }
    XCTAssertEqual(ref.mimeType, "image/jpeg")
  }

  func test_bad_base64_or_non_image_bytes_are_ignored_not_thrown() {
    let bad = TestImages.update([
      "sessionUpdate": "agent_message_chunk", "content": ["type": "image", "data": "%%%%", "mimeType": "image/png"],
    ])
    XCTAssertEqual(decode(bad), .update(.unknown(kind: "agent_message_chunk")))
    let text = Data("not an image at all".utf8).base64EncodedString()
    let notImage = TestImages.update([
      "sessionUpdate": "agent_message_chunk", "content": ["type": "image", "data": text, "mimeType": "image/png"],
    ])
    XCTAssertEqual(decode(notImage), .update(.unknown(kind: "agent_message_chunk")))
    let mixed = TestImages.update([
      "sessionUpdate": "tool_call_update", "toolCallId": "t", "status": "completed",
      "content": [
        ["type": "content", "content": ["type": "image", "data": "!!", "mimeType": "image/png"]],
        ["type": "content", "content": ["type": "text", "text": "kept"]],
      ],
    ])
    guard case let .update(.toolCallUpdate(fields)) = decode(mixed) else { return XCTFail() }
    XCTAssertNil(fields.images)
    XCTAssertEqual(fields.text, "kept")
  }

  func test_an_oversize_image_is_skipped() {
    let big = Data(count: ChatImageIntake.maxDecodedBytes + 1)
    XCTAssertNil(ChatImageIntake.prepare(data: big, mimeType: "image/png"))
    XCTAssertNil(ChatImageIntake.prepare(base64: big.base64EncodedString(), mimeType: "image/png"))
    XCTAssertNil(ChatImageIntake.prepare(base64: "", mimeType: "image/png"))
  }

  func test_the_same_picture_twice_shares_one_file_and_one_id() throws {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = files.images("c")
    let png = TestImages.png()
    _ = decode(TestImages.agentImage(png), store)
    _ = decode(TestImages.readResult(png), store)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.directory.path).count, 1)
  }

  func test_a_raw_output_that_is_image_json_is_never_kept() {
    let png = TestImages.png().base64EncodedString()
    let asText = "[{\"source\":{\"data\":\"\(png)\"},\"type\":\"image\"}]"
    let line = TestImages.update([
      "sessionUpdate": "tool_call_update", "toolCallId": "t", "rawOutput": asText,
    ])
    guard case let .update(.toolCallUpdate(fields)) = decode(line) else { return XCTFail() }
    XCTAssertNil(fields.rawOutput)
    let big = String(repeating: "A", count: ChatToolDetail.blobRun)
    XCTAssertTrue(ChatToolDetail.looksLikeBlob(big))
    XCTAssertFalse(ChatToolDetail.looksLikeBlob("plain text with spaces " + String(repeating: "word ", count: 2000)))
  }

  func test_image_block_in_a_permission_request_is_not_stored() throws {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = files.images("c")
    let b64 = TestImages.png().base64EncodedString()
    let request: [String: Any] = [
      "jsonrpc": "2.0", "id": 1, "method": "session/request_permission",
      "params": [
        "toolCall": ["toolCallId": "t", "content": [["type": "content", "content": ["type": "image", "data": b64]]]],
        "options": [["optionId": "a", "name": "Allow", "kind": "allow_once"]],
      ],
    ]
    let line = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
    guard case .permissionRequest = decode(line, store) else { return XCTFail() }
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.directory.path))
  }
}

final class ChatImageStoreTests: XCTestCase {
  func test_files_are_content_addressed_and_written_once() throws {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = files.images("chat")
    let png = TestImages.png()
    let ref = try XCTUnwrap(ChatImageIntake.prepare(data: png, mimeType: nil)).ref
    XCTAssertEqual(ref.id.count, 64)
    store.write(png, for: ref)
    store.write(png, for: ref)
    XCTAssertTrue(store.exists(ref))
    XCTAssertEqual(try Data(contentsOf: store.url(for: ref)), png)
  }

  func test_the_directory_is_protected_and_kept_out_of_backups() throws {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = files.images("chat")
    let ref = try XCTUnwrap(store.put(ChatImageAttachment(mimeType: "image/png", data: TestImages.png().base64EncodedString())))
    XCTAssertEqual(try store.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    for path in [store.directory.path, store.url(for: ref).path] {
      if let level = try FileManager.default.attributesOfItem(atPath: path)[.protectionKey] as? FileProtectionType {
        XCTAssertEqual(level, .completeUntilFirstUserAuthentication)
      }
    }
  }

  func test_put_refuses_what_is_not_an_image() {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    XCTAssertNil(files.images("c").put(ChatImageAttachment(mimeType: "image/jpeg", data: "")))
    XCTAssertNil(files.images("c").put(ChatImageAttachment(mimeType: "image/jpeg", data: "@@")))
  }

  func test_clearing_a_chat_removes_its_images_and_only_its_own() throws {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let one = files.images("one")
    let two = files.images("two")
    let a = try XCTUnwrap(one.put(.init(mimeType: "image/png", data: TestImages.png(hue: 0.1).base64EncodedString())))
    let b = try XCTUnwrap(two.put(.init(mimeType: "image/png", data: TestImages.png(hue: 0.9).base64EncodedString())))
    files.clear("one")
    XCTAssertFalse(one.exists(a))
    XCTAssertTrue(two.exists(b))
  }

  func test_the_oldest_files_go_first_across_chats_and_the_newest_stays() throws {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = TestImages.png(64, 64, hue: 0.2)
    let a = try XCTUnwrap(ChatImageIntake.prepare(data: probe, mimeType: nil)).ref
    let b = try XCTUnwrap(ChatImageIntake.prepare(data: TestImages.png(64, 64, hue: 0.7), mimeType: nil)).ref
    let budget = probe.count + 10
    let first1 = ChatImageStore(files: files, chat: "one", budget: budget)
    let second = ChatImageStore(files: files, chat: "two", budget: budget)
    first1.write(probe, for: a)
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -100)], ofItemAtPath: first1.url(for: a).path)
    second.write(TestImages.png(64, 64, hue: 0.7), for: b)
    XCTAssertFalse(first1.exists(a), "oldest evicted")
    XCTAssertTrue(second.exists(b), "the file just written is kept")
  }

  func test_a_missing_file_is_reported_not_thrown() {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let ref = ChatImageRef(id: String(repeating: "a", count: 64), mimeType: "image/png", pixelWidth: 1, pixelHeight: 1, byteCount: 1)
    XCTAssertFalse(files.images("c").exists(ref))
    let library = ChatImageLibrary(store: files.images("c"))
    XCTAssertFalse(ChatImageChips.canShow([ref], in: library))
    XCTAssertFalse(ChatImageChips.canShow([ref], in: nil))
  }

  func test_accessibility_label_names_the_size() {
    let ref = ChatImageRef(id: "x", mimeType: "image/png", pixelWidth: 1920, pixelHeight: 1080, byteCount: 1)
    XCTAssertEqual(ref.accessibilityLabel, "Image, 1920 by 1080")
  }
}

final class ChatImageThumbnailTests: XCTestCase {
  func test_a_large_image_is_decoded_no_larger_than_the_requested_size() throws {
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = files.images("c")
    let big = TestImages.jpeg(4000, 3000)
    let ref = try XCTUnwrap(ChatImageIntake.prepare(data: big, mimeType: nil)).ref
    store.write(big, for: ref)
    XCTAssertEqual(ref.pixelWidth, 4000)
    XCTAssertEqual(ChatImageThumbnail.options(maxPixel: ChatImageThumbnail.rowMaxPixel)[kCGImageSourceThumbnailMaxPixelSize] as? Int, 1200)
    let thumb = try XCTUnwrap(ChatImageThumbnail.make(url: store.url(for: ref), maxPixel: ChatImageThumbnail.rowMaxPixel))
    XCTAssertLessThanOrEqual(max(thumb.width, thumb.height), 1200)
    XCTAssertGreaterThan(max(thumb.width, thumb.height), 1000)
    let chip = try XCTUnwrap(ChatImageThumbnail.make(url: store.url(for: ref), maxPixel: ChatImageThumbnail.chipMaxPixel))
    XCTAssertLessThanOrEqual(max(chip.width, chip.height), 168)
  }

  func test_a_missing_file_gives_no_thumbnail() {
    XCTAssertNil(ChatImageThumbnail.make(url: URL(fileURLWithPath: "/nonexistent/x"), maxPixel: 100))
  }
}

final class ChatImageReplayTests: XCTestCase {
  private func lines(_ png: Data, _ jpeg: Data) -> [String] {
    [
      TestImages.text("Looking. "),
      TestImages.update(["sessionUpdate": "tool_call", "toolCallId": "r1", "title": "Read pic.png", "kind": "read", "status": "pending"]),
      TestImages.readResult(png),
      TestImages.agentImage(jpeg, mime: nil),
      TestImages.agentImage(png),
      TestImages.text("Done."),
    ]
  }

  func test_images_land_in_state_in_order_with_the_text() throws {
    let png = TestImages.png(), jpeg = TestImages.jpeg()
    let log = Data((lines(png, jpeg).joined(separator: "\n") + "\n").utf8)
    let state = try ChatTranscriptBuilder.replay(log: log, journal: ChatJournal())
    let kinds = state.items.map(\.kind)
    XCTAssertEqual(kinds.count, 4)
    guard case .assistant = kinds[0], case let .tool(call) = kinds[1], case let .images(refs, _) = kinds[2],
      case .assistant = kinds[3]
    else { return XCTFail("\(kinds)") }
    XCTAssertEqual(call.images.count, 1)
    XCTAssertNil(call.rawOutput)
    XCTAssertEqual(refs.map(\.mimeType), ["image/jpeg", "image/png"])
  }

  func test_live_replay_and_every_snapshot_cut_agree_and_missing_files_are_rewritten() throws {
    let png = TestImages.png(), jpeg = TestImages.jpeg()
    let all = lines(png, jpeg)
    let (files, root) = TestImages.tempFiles()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = files.images("c")
    let full = Data((all.joined(separator: "\n") + "\n").utf8)
    let expected = try ChatTranscriptBuilder.replay(log: full, journal: ChatJournal())
    func offset(_ count: Int) -> Int { all.prefix(count).reduce(0) { $0 + $1.utf8.count + 1 } }
    for count in 1...all.count {
      var live = ChatTranscriptBuilder(journal: ChatJournal(), images: store)
      try live.feed(full.subdata(in: 0..<offset(count)))
      let snapshot = ChatSnapshot(identity: 1, offset: offset(count), journal: ChatJournal(), state: live.state)
      let stored = try JSONDecoder().decode(ChatSnapshot.self, from: JSONEncoder().encode(snapshot))
      var resumed = ChatTranscriptBuilder(journal: ChatJournal(), resuming: stored, images: store)
      try resumed.feed(full.subdata(in: offset(count)..<full.count))
      resumed.finish()
      XCTAssertEqual(resumed.state, expected, "cut after \(count)")
    }
    try FileManager.default.removeItem(at: store.directory)
    var again = ChatTranscriptBuilder(journal: ChatJournal(), images: store)
    try again.feed(full)
    XCTAssertEqual(again.state, expected)
    for item in again.state.items {
      if case let .images(refs, _) = item.kind { XCTAssertTrue(refs.allSatisfy(store.exists)) }
    }
  }

  func test_the_user_prompt_keeps_its_image_ids_and_old_journals_still_decode() throws {
    let ref = ChatImageRef(id: "abc", mimeType: "image/png", pixelWidth: 2, pixelHeight: 3, byteCount: 9)
    var journal = ChatJournal()
    journal.entries = [.init(kind: .prompt, offset: 0, text: "look", imageCount: 1, images: [ref])]
    let decoded = try JSONDecoder().decode(ChatJournal.self, from: JSONEncoder().encode(journal))
    XCTAssertEqual(decoded, journal)
    let state = try ChatTranscriptBuilder.replay(log: Data(), journal: decoded)
    XCTAssertEqual(state.items.map(\.kind), [.user(text: "look", imageCount: 1, offset: 0, images: [ref])])

    let old = Data(#"{"entries":[{"kind":"prompt","offset":0,"text":"hi","imageCount":2}],"nextRequestId":1}"#.utf8)
    let legacy = try JSONDecoder().decode(ChatJournal.self, from: old)
    XCTAssertEqual(legacy.entries[0].images, [])
    XCTAssertEqual(legacy.entries[0].imageCount, 2)
    XCTAssertNotEqual(
      ChatSnapshot.digest([.init(kind: .prompt, offset: 0, text: "x", images: [ref])]),
      ChatSnapshot.digest([.init(kind: .prompt, offset: 0, text: "x")]))
  }
}

final class ChatToolDetailCapTests: XCTestCase {
  func test_a_long_line_is_cut_with_an_ellipsis() {
    let line = String(repeating: "x ", count: 5_000)
    guard case let .code(shown)? = ChatToolDetail.blocks(text: nil, rawOutput: line).first else { return XCTFail() }
    XCTAssertEqual(shown[0].count, ChatToolDetail.maxLineCharacters + 1)
    XCTAssertTrue(shown[0].hasSuffix("\u{2026}"))
  }

  func test_image_json_text_is_suppressed_everywhere() {
    let dump = "[{\"source\":{\"data\":\"\(String(repeating: "iVBORw0KGgo", count: 400))\"},\"type\":\"image\"}]"
    XCTAssertFalse(ChatToolDetail.hasContent(text: nil, rawOutput: dump))
    XCTAssertFalse(ChatToolDetail.hasContent(text: dump, rawOutput: nil))
    XCTAssertEqual(ChatToolDetail.blocks(text: nil, rawOutput: dump), [])
    XCTAssertEqual(ChatToolDetail.blocks(text: dump, rawOutput: dump), [])
  }

  func test_huge_text_is_bounded_before_parsing() {
    let huge = (0..<50_000).map { "line \($0)" }.joined(separator: "\n")
    guard case let .code(shown)? = ChatToolDetail.blocks(text: nil, rawOutput: huge).first else { return XCTFail() }
    XCTAssertEqual(shown.count, ChatToolDetail.maxCodeLines + 1)
  }
}
