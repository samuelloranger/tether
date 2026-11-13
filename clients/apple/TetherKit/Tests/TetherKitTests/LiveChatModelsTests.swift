import XCTest

@testable import TetherKit

@MainActor
final class LiveChatModelsTests: XCTestCase {
  private func model(_ name: String) -> ChatSessionModel {
    ChatSessionModel(chatName: name, cwd: "/work/project", readOnly: false, store: InMemoryChatJournalStore()) {
      _, _ in throw CancellationError()
    }
  }

  private func route(_ name: String, startedHere: Bool = false) -> ChatRoute {
    var route = ChatRoute(name: name, cwd: "/work/project", readOnly: false)
    route.startedHere = startedHere
    return route
  }

  func testOpeningTheSameChatAgainReusesItsModel() {
    let cache = LiveChatModels()
    let first = cache.model(for: route("chat-a"), fresh: 0) { model("chat-a") }
    let second = cache.model(for: route("chat-a"), fresh: 0) { model("chat-a") }
    XCTAssertTrue(first === second)
    XCTAssertEqual(cache.liveCount, 1)
  }

  func testPastTheLimitTheLeastRecentlyShownChatIsDropped() {
    let cache = LiveChatModels()
    var opened: [ChatSessionModel] = []
    for i in 0...LiveChatModels.limit {
      let name = "chat-\(i)"
      opened.append(cache.model(for: route(name), fresh: 0) { model(name) })
    }
    XCTAssertEqual(cache.liveCount, LiveChatModels.limit)
    // The first chat was evicted: opening it is a new model, not the old stream.
    let again = cache.model(for: route("chat-0"), fresh: 0) { model("chat-0") }
    XCTAssertFalse(again === opened[0])
  }

  func testStartingTheSameChatAgainGetsANewModel() {
    let cache = LiveChatModels()
    let first = cache.model(for: route("chat-a", startedHere: true), fresh: 1) { model("chat-a") }
    let second = cache.model(for: route("chat-a", startedHere: true), fresh: 2) { model("chat-a") }
    XCTAssertFalse(first === second)
    XCTAssertEqual(cache.liveCount, 1)
  }

  func testComingBackRedialsEveryKeptChatNotOnlyTheOneOnScreen() async {
    let cache = LiveChatModels()
    var dials: [String: Int] = [:]
    var opened: [ChatSessionModel] = []
    for name in ["chat-a", "chat-b"] {
      let kept = cache.model(for: route(name), fresh: 0) {
        ChatSessionModel(chatName: name, cwd: "/work/project", readOnly: false, store: InMemoryChatJournalStore()) {
          _, _ in
          dials[name, default: 0] += 1
          throw CancellationError()
        }
      }
      await kept.connect()
      opened.append(kept)
    }
    XCTAssertEqual(dials, ["chat-a": 1, "chat-b": 1])
    cache.sceneBecameActive()
    let redialed = await eventually { dials == ["chat-a": 2, "chat-b": 2] }
    XCTAssertTrue(redialed, "\(dials)")
    opened.forEach { $0.leave() }
  }

  func testLeavingAllForgetsEveryModel() {
    let cache = LiveChatModels()
    for i in 0..<3 {
      let name = "chat-\(i)"
      _ = cache.model(for: route(name), fresh: 0) { model(name) }
    }
    cache.leaveAll()
    XCTAssertEqual(cache.liveCount, 0)
  }
}
