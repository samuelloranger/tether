import Foundation

/// What the agent's byte log cannot contain: the user's prompts and permission answers, each
/// stamped with the log offset (end of the last processed line) at the moment it happened.
struct ChatJournal: Codable, Equatable, Sendable {
  struct Entry: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
      case prompt, answer, silentRequest
      /// Stop was pressed: replay shows the same notice and drops the same queued labels.
      case cancel
      /// A question answered here: `optionId` holds the action and `content` the form values.
      case questionAnswer
      /// An answer the host recorded while no client was attached; offset 0, applied before the replay.
      case hostAnswer
    }
    var kind: Kind
    var offset: Int
    var text: String?
    var requestId: ACPID?
    var optionId: String?
    var content: [String: ChatQuestionValue]?
    /// Image bytes are never stored; only how many went with the prompt.
    var imageCount = 0

    init(
      kind: Kind, offset: Int, text: String? = nil, requestId: ACPID? = nil, optionId: String? = nil,
      content: [String: ChatQuestionValue]? = nil, imageCount: Int = 0
    ) {
      self.kind = kind
      self.offset = offset
      self.text = text
      self.requestId = requestId
      self.optionId = optionId
      self.content = content
      self.imageCount = imageCount
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      kind = try container.decode(Kind.self, forKey: .kind)
      offset = try container.decode(Int.self, forKey: .offset)
      text = try container.decodeIfPresent(String.self, forKey: .text)
      requestId = try container.decodeIfPresent(ACPID.self, forKey: .requestId)
      optionId = try container.decodeIfPresent(String.self, forKey: .optionId)
      content = try container.decodeIfPresent([String: ChatQuestionValue].self, forKey: .content)
      imageCount = try container.decodeIfPresent(Int.self, forKey: .imageCount) ?? 0
    }

    var event: ChatEvent? {
      switch kind {
      case .prompt:
        return text.map { .userPrompt(text: $0, imageCount: imageCount, atOffset: offset, requestId: requestId) }
      case .cancel:
        return .cancelRequested
      case .silentRequest:
        return requestId.map { .silentRequest(requestId: $0) }
      case .answer:
        guard let requestId, let optionId else { return nil }
        return .permissionAnswered(requestId: requestId, optionId: optionId)
      case .questionAnswer:
        guard let requestId, let action = optionId.flatMap(ChatQuestionAction.init(rawValue:)) else { return nil }
        return .questionAnswered(requestId: requestId, action: action, content: content ?? [:])
      case .hostAnswer:
        guard let requestId, let optionId else { return nil }
        return .hostAnswered(requestId: requestId, optionId: optionId)
      }
    }
  }

  var sessionId: String?
  /// Set when the chat continues an earlier conversation: the agent is asked to `session/load` this id
  /// instead of `session/new`, and a redial before the load answered must ask for the same one.
  var loadedSessionId: String?
  /// Persisted so a resumed client never reuses an id the agent already answered.
  var nextRequestId = 1
  var entries: [Entry] = []

  var answeredRequestIds: Set<ACPID> {
    Set(entries.compactMap { [.answer, .hostAnswer, .questionAnswer].contains($0.kind) ? $0.requestId : nil })
  }

  /// The entries a reducer standing at `offset` has applied, in the order they were journaled.
  func entries(upTo offset: Int) -> [Entry] { entries.filter { $0.offset <= offset } }
}

/// The reducer's state at a line boundary of the host's log, so a reconnect attaches from
/// `offset` instead of replaying everything. The journal stays authoritative: the snapshot only
/// counts which of its entries it already reflects.
struct ChatSnapshot: Codable, Equatable, Sendable {
  static let currentVersion = 3

  var version = ChatSnapshot.currentVersion
  /// The host session's created time (unix seconds): a session recreated under the same name has another.
  var identity: Int
  /// End of the last processed line; also where the next attach starts.
  var offset: Int
  /// How many of the journal's entries at or before `offset` the state reflects, and their digest.
  var journalApplied: Int
  var journalDigest: String
  var state: ChatState

  init(identity: Int, offset: Int, journal: ChatJournal, state: ChatState) {
    let applied = journal.entries(upTo: offset)
    self.identity = identity
    self.offset = offset
    self.journalApplied = applied.count
    self.journalDigest = Self.digest(applied)
    self.state = state
  }

  /// True when the journal still contains, in order, the entries this state was built from.
  func isConsistent(with journal: ChatJournal) -> Bool {
    let applied = journal.entries(upTo: offset)
    return version == Self.currentVersion && applied.count >= journalApplied
      && Self.digest(applied.prefix(journalApplied)) == journalDigest
  }

  private static func canonical(_ content: [String: ChatQuestionValue]) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return (try? encoder.encode(content)).map { String(decoding: $0, as: UTF8.self) } ?? ""
  }

  /// FNV-1a over the entries' fields; `Hasher` is seeded per process, so it cannot be stored.
  static func digest(_ entries: some Sequence<ChatJournal.Entry>) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for entry in entries {
      var fields = [
        entry.kind.rawValue, "\(entry.offset)", entry.text ?? "", entry.requestId.map { "\($0)" } ?? "",
        entry.optionId ?? "", "\(entry.imageCount)",
      ]
      if let content = entry.content { fields.append(canonical(content)) }
      let line = fields.joined(separator: "\u{1F}") + "\n"
      for byte in line.utf8 {
        hash ^= UInt64(byte)
        hash = hash &* 0x0000_0100_0000_01B3
      }
    }
    return String(hash, radix: 16)
  }
}

protocol ChatSnapshotStore: Sendable {
  func load() -> ChatSnapshot?
  func save(_ snapshot: ChatSnapshot)
  func clear()
}

final class InMemoryChatSnapshotStore: ChatSnapshotStore, @unchecked Sendable {
  private let lock = NSLock()
  private var snapshot: ChatSnapshot?
  private var saves = 0

  init(_ snapshot: ChatSnapshot? = nil) { self.snapshot = snapshot }

  var saveCount: Int { lock.lock(); defer { lock.unlock() }; return saves }
  func load() -> ChatSnapshot? { lock.lock(); defer { lock.unlock() }; return snapshot }
  func save(_ snapshot: ChatSnapshot) { lock.lock(); self.snapshot = snapshot; saves += 1; lock.unlock() }
  func clear() { lock.lock(); snapshot = nil; lock.unlock() }
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

  /// Continues from a snapshot the caller has checked with `isConsistent`. Journal entries
  /// added since it was taken are applied now; the rest wait for the log to reach their offset.
  init(journal: ChatJournal, resuming snapshot: ChatSnapshot) {
    state = snapshot.state
    state.connection = .live
    consumedOffset = snapshot.offset
    receivedBytes = snapshot.offset
    splitter = ACPLineSplitter(startOffset: snapshot.offset)
    pending = journal.entries.enumerated()
      .filter { $0.element.offset > snapshot.offset }
      .sorted { ($0.element.offset, $0.offset) < ($1.element.offset, $1.offset) }
      .map(\.element)
    for entry in journal.entries(upTo: snapshot.offset).dropFirst(snapshot.journalApplied) {
      if let event = entry.event { state = ChatReducer.reduce(state, event) }
    }
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
