import Foundation

/// Chats kept connected while another chat or the terminal is in front.
///
/// Each model owns a connection to its host's chat holder, and the agent behind that holder stays
/// awake, so the budget is small: four is enough for instant switching back without pinning four
/// agents on the host. The least recently shown one hangs up first; its model is dropped and its
/// next open is a normal replay.
@MainActor
final class LiveChatModels {
  static let limit = 4

  private struct Entry {
    let model: ChatSessionModel
    /// The `DrawerContent.fresh` counter the model was built for. A chat started again under the
    /// same name is a different conversation, so it gets a new model rather than the old stream.
    let fresh: Int
  }

  private var entries: [String: Entry] = [:]
  /// Least recently shown first.
  private var order: [String] = []

  /// The model for a route, reusing one already open on the same chat.
  func model(for route: ChatRoute, fresh: Int, make: () -> ChatSessionModel) -> ChatSessionModel {
    if let entry = entries[route.name], !route.startedHere || entry.fresh == fresh {
      touch(route.name)
      return entry.model
    }
    leave(route.name)
    let model = make()
    entries[route.name] = Entry(model: model, fresh: fresh)
    touch(route.name)
    evictPastLimit(keeping: route.name)
    return model
  }

  /// Drops a chat the user or the host ended: its view is gone, and it must not be reused.
  func leave(_ name: String) {
    entries.removeValue(forKey: name)?.model.leave()
    order.removeAll { $0 == name }
  }

  /// The app is going to the background; a suspended socket would be reaped anyway, so every
  /// kept chat drops its own and redials cleanly when its view comes back.
  func sceneEnteredBackground() {
    for entry in entries.values {
      entry.model.sceneEnteredBackground()
    }
  }

  func leaveAll() {
    for entry in entries.values {
      entry.model.leave()
    }
    entries.removeAll()
    order.removeAll()
  }

  /// Number of chats still connected, for a test or a future budget display.
  var liveCount: Int { entries.count }

  private func touch(_ name: String) {
    order.removeAll { $0 == name }
    order.append(name)
  }

  private func evictPastLimit(keeping name: String) {
    while entries.count > Self.limit {
      guard let victim = order.first(where: { $0 != name }) else { return }
      leave(victim)
    }
  }
}
