import XCTest
@testable import TetherKit

@MainActor
final class ChatOutboxPersistenceTests: XCTestCase {
  private func model(_ store: InMemoryChatOutboxStore, stream: any TerminalByteStream) -> ChatSessionModel {
    ChatSessionModel(
      chatName: "chat-t", cwd: "/work/project", readOnly: false,
      store: InMemoryChatJournalStore(ACPFixture.journal), outbox: store
    ) { _, _ in stream }
  }

  private func live(_ model: ChatSessionModel, _ inner: ScriptedByteStream) async -> Bool {
    Task { await model.connect() }
    inner.push(ACPFixture.log())
    return await eventually(timeout: 4) { model.link.phase == .live }
  }

  func test_restored_messages_keep_their_text_and_only_count_their_images() {
    let id = UUID()
    let outbox = ChatOutbox(restoring: [.init(id: id, text: "hello", imageCount: 2), .init(id: UUID(), text: "", imageCount: 1)])
    XCTAssertEqual(outbox.failed.count, 2)
    XCTAssertEqual(outbox.failed[0].text, "hello")
    XCTAssertTrue(outbox.failed[0].imagesNotKept)
    XCTAssertTrue(outbox.failed[0].canRetry)
    XCTAssertFalse(outbox.failed[1].canRetry, "an images-only message has nothing left to send")
    XCTAssertEqual(outbox.persisted.first, .init(id: id, text: "hello", imageCount: 2))

    var fresh = ChatOutbox()
    fresh.recordFailure("with pics", images: [ChatImageAttachment(mimeType: "image/jpeg", data: "AAAA")])
    XCTAssertFalse(fresh.failed[0].imagesNotKept)
    XCTAssertEqual(fresh.persisted[0].imageCount, 1)
  }

  func test_the_file_store_round_trips_and_an_empty_outbox_removes_the_file() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let files = ChatLocalFiles(directory: directory)
    let store = files.outbox("chat-a")
    XCTAssertEqual(store.load(), [])
    let message = PersistedFailedMessage(id: UUID(), text: "again", imageCount: 3)
    store.save([message])
    XCTAssertEqual(store.load(), [message])
    XCTAssertEqual(files.outbox("chat-b").load(), [])
    store.save([])
    XCTAssertFalse(FileManager.default.fileExists(atPath: files.url("chat-a", FileChatOutboxStore.kind).path))
    files.write(Data("garbage".utf8), "chat-a", FileChatOutboxStore.kind)
    XCTAssertEqual(store.load(), [])
    store.save([message])
    files.clear("chat-a")
    XCTAssertEqual(store.load(), [])
  }

  func test_a_failed_send_is_stored_restored_on_the_next_open_and_cleared_by_a_successful_retry() async throws {
    let store = InMemoryChatOutboxStore()
    let inner = ScriptedByteStream()
    let first = model(store, stream: SwitchableWriteStream(inner))
    let up = await live(first, inner)
    XCTAssertTrue(up)
    let image = ChatImageAttachment(mimeType: "image/jpeg", data: "AAAA")
    XCTAssertTrue(first.send(text: "hello", images: [image]))
    let stored = await eventually { store.load().count == 1 }
    XCTAssertTrue(stored)
    XCTAssertEqual(store.load()[0].text, "hello")
    XCTAssertEqual(store.load()[0].imageCount, 1)
    first.leave()

    let good = ScriptedByteStream()
    let second = model(store, stream: good)
    XCTAssertEqual(second.outbox.failed.map(\.text), ["hello"], "restored before any connection")
    XCTAssertTrue(second.outbox.failed[0].imagesNotKept)
    let up2 = await live(second, good)
    XCTAssertTrue(up2)
    second.retry(try XCTUnwrap(second.outbox.failed.first?.id))
    let sent = await eventually { good.writtenText.contains("\"text\":\"hello\"") }
    XCTAssertTrue(sent)
    XCTAssertFalse(good.writtenText.contains("\"type\":\"image\""), "image bytes are not kept")
    let cleared = await eventually { store.load().isEmpty }
    XCTAssertTrue(cleared)
    XCTAssertTrue(second.outbox.failed.isEmpty)
    second.leave()
  }

  func test_a_retry_that_fails_again_stays_stored_and_a_discard_removes_it() async throws {
    let message = PersistedFailedMessage(id: UUID(), text: "stuck", imageCount: 0)
    let store = InMemoryChatOutboxStore([message])
    let inner = ScriptedByteStream()
    let model = model(store, stream: SwitchableWriteStream(inner))
    let up = await live(model, inner)
    XCTAssertTrue(up)
    model.retry(message.id)
    let failedAgain = await eventually { model.outbox.failed.map(\.text) == ["stuck"] && model.outbox.failed[0].id != message.id }
    XCTAssertTrue(failedAgain)
    XCTAssertEqual(store.load().map(\.text), ["stuck"])
    model.discard(try XCTUnwrap(model.outbox.failed.first?.id))
    XCTAssertTrue(store.load().isEmpty)
    model.leave()
  }
}
