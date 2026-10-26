import Foundation

/// The `tether acp` commands a chat runs over ssh exec.
enum ACPHostCommand {
  /// Pinned: the transcript reducer is written against this adapter's output, so a host never
  /// picks up a newer one on its own.
  static let adapterPackage = "@agentclientprotocol/claude-agent-acp"
  static let adapterVersion = "0.95.0"
  static let spawnCommand = "npx -y \(adapterPackage)@\(adapterVersion)"
  private static let prefix = "PATH=\"$HOME/.local/bin:$PATH\" tether acp"

  /// `--spawn` only starts an agent when the host has none for the name; a resume leaves it off so
  /// a lost holder never starts a fresh agent under a journal that names the old session.
  static func attach(
    name: String, cwd: String, spawn: Bool, from offset: Int = 0, spawnCommand: String = ACPHostCommand.spawnCommand
  ) -> String {
    var command = "\(prefix) attach \(shellQuote(name)) --from \(offset)"
    if spawn { command += " --spawn \(shellQuote(spawnCommand)) --cwd \(shellQuote(cwd))" }
    return command
  }

  static let list = "\(prefix) ls"
  /// One JSON line per chat with what is happening in it. A host that predates it prints an
  /// "unknown command" line, which the listing reads as unsupported (stderr is folded in for that).
  static let status = "\(prefix) status 2>&1"
  /// For the chat list screen, which has to show why a host that cannot list says nothing.
  static let listWithErrors = "\(list) 2>&1"
  static let home = "printf %s \"$HOME\""

  /// Earlier conversations in `cwd`, newest first, as JSON lines. Runs the adapter briefly on the host.
  static func sessions(cwd: String, limit: Int) -> String {
    "\(prefix) sessions \(shellQuote(cwd)) --limit \(limit) 2>&1"
  }

  static func kill(name: String) -> String { "\(prefix) kill \(shellQuote(name))" }
}

struct ACPChatSummary: Equatable, Identifiable, Sendable {
  var name: String
  var isRunning: Bool
  var logBytes: Int
  var cwd: String
  var created: Date
  var spawn: String
  /// From `acp status`; a host without it leaves these at their defaults.
  var turn: ChatHostTurn = .idle
  var hostTitle: String?
  var hasStatus = false

  var id: String { name }

  /// The folder name; a chat started in the home directory or the root has no better label.
  var title: String { ChatFormat.folderName(cwd) }
}

/// `name<TAB>state<TAB>logBytes<TAB>cwd<TAB>createdUnix<TAB>spawn`, one chat per line.
enum ACPChatListing {
  struct Result: Equatable {
    var chats: [ACPChatSummary]
    var skipped: [String]
  }

  static func parse(_ output: String) -> Result {
    var chats: [ACPChatSummary] = []
    var skipped: [String] = []
    for raw in output.split(whereSeparator: \.isNewline) {
      let line = String(raw)
      let fields = line.split(separator: "\t", maxSplits: 5, omittingEmptySubsequences: false).map(String.init)
      guard fields.count >= 5, !fields[0].isEmpty,
        fields[1] == "running" || fields[1] == "ended",
        let bytes = Int(fields[2]), let created = TimeInterval(fields[4])
      else {
        skipped.append(line)
        continue
      }
      chats.append(
        ACPChatSummary(
          name: fields[0], isRunning: fields[1] == "running", logBytes: bytes, cwd: fields[3],
          created: Date(timeIntervalSince1970: created), spawn: fields.count > 5 ? fields[5] : ""))
    }
    chats.sort { $0.created > $1.created }
    return Result(chats: chats, skipped: skipped)
  }
}

enum ACPCwd {
  /// `session/new` needs an absolute path, so a typed `~` is resolved against the host's home.
  static func expand(_ text: String, home: String) -> String {
    var path = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if path.isEmpty || path == "~" { return home }
    if path.hasPrefix("~/") { path = home + String(path.dropFirst(1)) }
    while path.count > 1, path.hasSuffix("/") { path.removeLast() }
    return path
  }

  static func needsHome(_ text: String) -> Bool {
    let path = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return path.isEmpty || path == "~" || path.hasPrefix("~/")
  }
}

/// A chat this phone has a session id for resumes; any other can only be read.
enum ChatOpenMode: Equatable {
  case resume, readOnly

  /// A chat this phone began but never got a session for (a signed-out agent) has sent requests,
  /// so it reopens as live and asks again; a chat it never touched stays read only.
  static func mode(for journal: ChatJournal) -> ChatOpenMode {
    journal.sessionId == nil && journal.nextRequestId <= 1 ? .readOnly : .resume
  }
}

struct ChatRoute: Hashable, Identifiable {
  var name: String
  var cwd: String
  var readOnly: Bool
  /// An earlier conversation to load instead of starting a new session.
  var loadSessionId: String?
  var id: String { name }

  static func newName() -> String {
    let letters = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    return "chat-" + String((0..<6).map { _ in letters.randomElement()! })
  }
}

/// Tracks the replay window after a (re)connect. The holder replays its whole log, so the
/// transcript is only trustworthy once no new state has arrived for `settleWindow`.
struct ChatLinkTracker: Equatable, Sendable {
  /// `ended` is the host's own word that the agent is gone for good; `lost` is only a dropped connection.
  enum Phase: Equatable, Sendable { case connecting, catchingUp, live, lost, ended }

  static let settleWindow: TimeInterval = 0.4

  private(set) var phase: Phase = .connecting
  private var lastActivity: Date?

  var allowsInteraction: Bool { phase == .live }

  mutating func dialStarted() { phase = .connecting }
  mutating func dialFailed() { phase = .lost }
  mutating func connectionLost() { if phase != .ended { phase = .lost } }
  mutating func ended() { phase = .ended }

  mutating func dialSucceeded(at now: Date) {
    phase = .catchingUp
    lastActivity = now
  }

  mutating func activity(at now: Date) {
    if phase == .catchingUp { lastActivity = now }
  }

  /// True when this call moved the link from catching up to live.
  @discardableResult
  mutating func settleIfQuiet(at now: Date) -> Bool {
    guard phase == .catchingUp, let lastActivity, now.timeIntervalSince(lastActivity) >= Self.settleWindow else {
      return false
    }
    phase = .live
    return true
  }
}

enum ChatReconnectPolicy {
  static func shouldReconnect(phase: ChatLinkTracker.Phase, dialInFlight: Bool, left: Bool) -> Bool {
    phase == .lost && !dialInFlight && !left
  }
}

/// Messages the agent never received. Delivered ones live in the transcript; these stay visible
/// with Retry and Discard rather than vanishing, and survive the chat being closed.
struct ChatOutbox: Equatable {
  struct Failed: Identifiable, Equatable {
    let id: UUID
    let text: String
    /// Kept in memory only, so a retry in this session can send them again.
    var images: [ChatImageAttachment] = []
    /// Images that went with the message but were not kept across a restart.
    var imagesLost = 0

    var imageCount: Int { images.count + imagesLost }
    var imagesNotKept: Bool { imagesLost > 0 }
    /// A message that was only images has nothing left to send once they are gone.
    var canRetry: Bool { !text.isEmpty || !images.isEmpty }
  }

  private(set) var failed: [Failed] = []

  init() {}

  init(restoring messages: [PersistedFailedMessage]) {
    failed = messages.map { Failed(id: $0.id, text: $0.text, imagesLost: $0.imageCount) }
  }

  var persisted: [PersistedFailedMessage] {
    failed.map { PersistedFailedMessage(id: $0.id, text: $0.text, imageCount: $0.imageCount) }
  }

  @discardableResult
  mutating func recordFailure(_ text: String, images: [ChatImageAttachment] = [], imagesLost: Int = 0, id: UUID = UUID()) -> Failed {
    let entry = Failed(id: id, text: text, images: images, imagesLost: imagesLost)
    failed.append(entry)
    return entry
  }

  func text(for id: UUID) -> String? { failed.first { $0.id == id }?.text }

  func entry(for id: UUID) -> Failed? { failed.first { $0.id == id } }

  mutating func discard(_ id: UUID) { failed.removeAll { $0.id == id } }
}

enum ChatPermissionRole: Equatable {
  case primary, secondary, destructive

  init(kind: String) {
    switch kind {
    case "allow_once": self = .primary
    case "reject_once", "reject_always": self = .destructive
    default: self = .secondary
    }
  }
}

enum ChatPermissionOptions {
  /// Allow once first, then the broader allows, reject last.
  static func ordered(_ options: [ACPPermissionOption]) -> [(option: ACPPermissionOption, role: ChatPermissionRole)] {
    func rank(_ role: ChatPermissionRole) -> Int {
      switch role {
      case .primary: 0
      case .secondary: 1
      case .destructive: 2
      }
    }
    return options.enumerated()
      .map { (index: $0.offset, option: $0.element, role: ChatPermissionRole(kind: $0.element.kind)) }
      .sorted { (rank($0.role), $0.index) < (rank($1.role), $1.index) }
      .map { ($0.option, $0.role) }
  }
}

extension ChatPermissionOptions {
  /// The three slots of the permission card: the one-off allow, the deny, and any broader allows.
  static func slots(_ options: [ACPPermissionOption]) -> (
    allow: ACPPermissionOption?, deny: ACPPermissionOption?, extras: [ACPPermissionOption]
  ) {
    let ordered = Self.ordered(options)
    let allow = ordered.first { $0.role == .primary }?.option
    let deny = ordered.first { $0.role == .destructive }?.option
    let extras = ordered.filter { $0.option.optionId != allow?.optionId && $0.option.optionId != deny?.optionId }
    return (allow, deny, extras.map(\.option))
  }
}

extension ChatPermissionOptions {
  struct Layout: Equatable {
    var primary: ACPPermissionOption?
    var reject: ACPPermissionOption?
    /// Every other option, in the order the card offers them.
    var more: [ACPPermissionOption]
    /// More than three options: the primary allow and the reject stay visible, the rest sit behind a disclosure.
    var collapsed: Bool
  }

  static func layout(_ options: [ACPPermissionOption]) -> Layout {
    let ordered = Self.ordered(options)
    let primary = ordered.first { $0.role == .primary }?.option ?? ordered.first { $0.role == .secondary }?.option
    let reject = ordered.first { $0.role == .destructive }?.option
    let rest = ordered.map(\.option).filter { $0.optionId != primary?.optionId && $0.optionId != reject?.optionId }
    return Layout(primary: primary, reject: reject, more: rest, collapsed: options.count > 3)
  }
}

enum ChatFormat {
  static func folderName(_ cwd: String) -> String {
    let trimmed = cwd.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard let last = trimmed.split(separator: "/").last else { return cwd == "/" ? "/" : "Home" }
    return String(last)
  }

  /// The folder a chat sits in, for the row's subtitle; nil at the root or for a bare `~`.
  static func parentPath(_ cwd: String) -> String? {
    var parts = cwd.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard !parts.isEmpty, cwd != "~" else { return nil }
    parts.removeLast()
    if parts.isEmpty { return cwd.hasPrefix("/") ? "/" : nil }
    return (cwd.hasPrefix("/") ? "/" : "") + parts.joined(separator: "/")
  }

  /// A short agent name from the command the host spawned, nil when it is not a known one.
  static func agentLabel(spawn: String) -> String? {
    let lower = spawn.lowercased()
    for (needle, label) in [("claude", "Claude"), ("codex", "Codex"), ("gemini", "Gemini"), ("cursor", "Cursor")]
    where lower.contains(needle) { return label }
    return nil
  }

  /// Used share of the context window in 0...1; nil when the agent reported no size.
  static func contextFraction(used: Int?, size: Int?) -> Double? {
    guard let used, let size, size > 0 else { return nil }
    return max(0, min(1, Double(used) / Double(size)))
  }

  /// 31043 -> "31k", 1_000_000 -> "1M".
  static func compactCount(_ value: Int) -> String {
    switch value {
    case 1_000_000...:
      let millions = Double(value) / 1_000_000
      return millions == millions.rounded() ? "\(Int(millions))M" : String(format: "%.1fM", millions)
    case 1_000...: return "\(Int((Double(value) / 1_000).rounded()))k"
    default: return "\(value)"
    }
  }

  static func contextSummary(used: Int?, size: Int?) -> String? {
    guard let used, let size, size > 0 else { return nil }
    let percent = max(0, min(100, Int((Double(used) / Double(size) * 100).rounded())))
    return "\(compactCount(used)) / \(compactCount(size)) · \(percent)%"
  }

  /// A path relative to the chat's folder when it sits inside it.
  static func relativePath(_ path: String, to cwd: String) -> String {
    let base = cwd.hasSuffix("/") ? cwd : cwd + "/"
    return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
  }
}

extension ChatState {
  /// Changes whenever the visible tail does; cheap to compare, unlike the whole state.
  var tailSignature: Int {
    var hasher = Hasher()
    hasher.combine(items.count)
    hasher.combine(turn)
    hasher.combine(pendingPermissions.count)
    hasher.combine(queuedItemIds.count)
    if let last = items.last {
      switch last.kind {
      case let .assistant(text, _), let .thought(text), let .notice(text), let .error(text):
        hasher.combine(text.utf8.count)
      case let .user(text, images, _):
        hasher.combine(images)
        hasher.combine(text.utf8.count)
      case let .tool(call): hasher.combine(call.status.rawValue)
      default: break
      }
    }
    return hasher.finalize()
  }
}
