import Foundation

/// What the agent's byte log cannot contain: the user's prompts and permission answers, each
/// stamped with the log offset (end of the last processed line) at the moment it happened.
struct ChatJournal: Codable, Equatable, Sendable {
  struct Entry: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable { case prompt, answer, silentRequest }
    var kind: Kind
    var offset: Int
    var text: String?
    var requestId: ACPID?
    var optionId: String?
    /// Image bytes are never stored; only how many went with the prompt.
    var imageCount = 0

    init(
      kind: Kind, offset: Int, text: String? = nil, requestId: ACPID? = nil, optionId: String? = nil,
      imageCount: Int = 0
    ) {
      self.kind = kind
      self.offset = offset
      self.text = text
      self.requestId = requestId
      self.optionId = optionId
      self.imageCount = imageCount
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      kind = try container.decode(Kind.self, forKey: .kind)
      offset = try container.decode(Int.self, forKey: .offset)
      text = try container.decodeIfPresent(String.self, forKey: .text)
      requestId = try container.decodeIfPresent(ACPID.self, forKey: .requestId)
      optionId = try container.decodeIfPresent(String.self, forKey: .optionId)
      imageCount = try container.decodeIfPresent(Int.self, forKey: .imageCount) ?? 0
    }

    var event: ChatEvent? {
      switch kind {
      case .prompt:
        return text.map { .userPrompt(text: $0, imageCount: imageCount, atOffset: offset) }
      case .silentRequest:
        return requestId.map { .silentRequest(requestId: $0) }
      case .answer:
        guard let requestId, let optionId else { return nil }
        return .permissionAnswered(requestId: requestId, optionId: optionId)
      }
    }
  }

  var sessionId: String?
  /// Persisted so a resumed client never reuses an id the agent already answered.
  var nextRequestId = 1
  var entries: [Entry] = []

  var answeredRequestIds: Set<ACPID> {
    Set(entries.compactMap { $0.kind == .answer ? $0.requestId : nil })
  }
}

protocol ChatJournalStore: Sendable {
  func load() -> ChatJournal
  func save(_ journal: ChatJournal)
}

final class InMemoryChatJournalStore: ChatJournalStore, @unchecked Sendable {
  private let lock = NSLock()
  private var journal: ChatJournal

  init(_ journal: ChatJournal = ChatJournal()) { self.journal = journal }

  func load() -> ChatJournal { lock.lock(); defer { lock.unlock() }; return journal }
  func save(_ journal: ChatJournal) { lock.lock(); self.journal = journal; lock.unlock() }
}

final class UserDefaultsChatJournalStore: ChatJournalStore, @unchecked Sendable {
  private let defaults: UserDefaults
  private let key: String

  init(name: String, defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.key = "tether.acp.journal.\(name)"
  }

  func load() -> ChatJournal {
    defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(ChatJournal.self, from: $0) } ?? ChatJournal()
  }

  func save(_ journal: ChatJournal) {
    defaults.set(try? JSONEncoder().encode(journal), forKey: key)
  }
}

/// Incremental form of the live path and the replay path at once: agent lines and journal entries
/// are merged by offset, so replaying the whole log gives the transcript the live session had.
struct ChatTranscriptBuilder {
  private(set) var state = ChatState()
  /// End of the last processed line; this is the offset journal entries are stamped with.
  private(set) var consumedOffset = 0
  /// Raw bytes taken from the stream, partial line included: the offset to reattach from.
  private(set) var receivedBytes = 0
  private var splitter = ACPLineSplitter()
  private var pending: [ChatJournal.Entry]

  init(journal: ChatJournal = ChatJournal()) {
    pending = journal.entries.enumerated()
      .sorted { ($0.element.offset, $0.offset) < ($1.element.offset, $1.offset) }
      .map(\.element)
    drain(upTo: 0)
  }

  /// Returns the decoded messages so a live client can route responses to waiting requests.
  @discardableResult
  mutating func feed(_ data: Data) throws -> [ACPInbound] {
    receivedBytes += data.count
    var messages: [ACPInbound] = []
    for line in try splitter.feed(data) {
      drain(upTo: line.start)
      let message = ACPDecoder.decode(line.bytes)
      messages.append(message)
      state = ChatReducer.reduce(state, .message(message))
      consumedOffset = line.end
      drain(upTo: line.end)
    }
    return messages
  }

  /// A live local event; the caller journals it at `consumedOffset`.
  mutating func apply(_ event: ChatEvent) {
    state = ChatReducer.reduce(state, event)
  }

  mutating func finish() {
    drain(upTo: Int.max)
  }

  private mutating func drain(upTo offset: Int) {
    while let first = pending.first, first.offset <= offset {
      pending.removeFirst()
      if let event = first.event { state = ChatReducer.reduce(state, event) }
    }
  }

  static func replay(log: Data, journal: ChatJournal) throws -> ChatState {
    var builder = ChatTranscriptBuilder(journal: journal)
    try builder.feed(log)
    builder.finish()
    return builder.state
  }
}
