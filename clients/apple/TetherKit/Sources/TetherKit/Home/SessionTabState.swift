import Foundation

/// The Mac tab strip's rules, free of UIKit and SSH: which sessions have tabs, which one is
/// active, which are attached, which rang while out of view.
struct SessionTabState: Equatable {
  /// OpenSSH's default `MaxSessions`: past it the host starts refusing channels.
  static let maxAttached = 10
  /// A tab created here may not show in `zmx ls` yet; it survives this many listings without it.
  static let unconfirmedListings = 3

  private(set) var names: [String] = []
  private(set) var active: String?
  private(set) var attached: Set<String> = []
  private(set) var attention: Set<String> = []
  private var lastViewed: [String: Int] = [:]
  private var unconfirmed: [String: Int] = [:]
  private var clock = 0
  private var killed: Set<String> = []

  struct Change: Equatable {
    var removed: [String] = []
    var evicted: [String] = []
    /// Set when the active tab moved on its own, so its controller needs opening.
    var newActive: String?
  }

  static func ordered(_ sessions: [ZmxSession]) -> [String] {
    sessions.sorted { ($0.created, $0.name) < ($1.created, $1.name) }.map(\.name)
  }

  /// The iOS rule for a first connect: `default` if present, else the newest.
  static func initialChoice(_ sessions: [ZmxSession]) -> String? {
    if sessions.contains(where: { $0.name == "default" }) { return "default" }
    return sessions.max { ($0.created, $0.name) < ($1.created, $1.name) }?.name
  }

  /// `default` on an empty host, else the first free `session-N` counting from count + 1.
  static func newSessionName(existing: [String]) -> String {
    if existing.isEmpty { return "default" }
    var n = existing.count + 1
    let taken = Set(existing)
    while taken.contains("session-\(n)") { n += 1 }
    return "session-\(n)"
  }

  func name(at index: Int) -> String? {
    names.indices.contains(index) ? names[index] : nil
  }

  /// Wraps around; nil with no active tab or a single tab.
  func neighbour(offset: Int) -> String? {
    guard let active, let index = names.firstIndex(of: active), names.count > 1 else { return nil }
    let count = names.count
    return names[((index + offset) % count + count) % count]
  }

  mutating func select(_ name: String) -> [String] {
    guard names.contains(name) else { return [] }
    active = name
    clock += 1
    lastViewed[name] = clock
    attention.remove(name)
    attached.insert(name)
    guard attached.count > Self.maxAttached else { return [] }
    guard let victim = attached.filter({ $0 != name }).min(by: { (lastViewed[$0] ?? 0) < (lastViewed[$1] ?? 0) })
    else { return [] }
    attached.remove(victim)
    return [victim]
  }

  /// A tab for a session this client is about to create or adopt, selected at once.
  mutating func open(_ name: String) -> [String] {
    if !names.contains(name) {
      names.append(name)
      unconfirmed[name] = Self.unconfirmedListings
    }
    return select(name)
  }

  mutating func noteBell(_ name: String) {
    guard name != active, names.contains(name) else { return }
    attention.insert(name)
  }

  /// Drops a tab; an active one hands over to the left neighbour, else the right.
  @discardableResult
  mutating func remove(_ name: String) -> String? {
    guard let index = names.firstIndex(of: name) else { return nil }
    names.remove(at: index)
    attached.remove(name)
    attention.remove(name)
    lastViewed[name] = nil
    unconfirmed[name] = nil
    guard active == name else { return nil }
    active = nil
    let next: String?
    if index > 0 { next = names[index - 1] } else { next = names.first }
    return next
  }

  /// A killed session can still show in a listing that was already in flight; its tab must not return.
  mutating func markKilled(_ name: String) { killed.insert(name) }

  /// Folds a fresh `zmx ls` into the strip.
  mutating func reconcile(listed rawListed: [ZmxSession]) -> Change {
    var change = Change()
    let rawNames = Set(rawListed.map(\.name))
    killed.formIntersection(rawNames)
    let listed = rawListed.filter { !killed.contains($0.name) }
    let listedOrder = Self.ordered(listed)
    let listedSet = Set(listedOrder)
    for name in unconfirmed.keys {
      if listedSet.contains(name) {
        unconfirmed[name] = nil
      } else if let left = unconfirmed[name] {
        unconfirmed[name] = left - 1
      }
    }
    let gone = Set(names.filter { !listedSet.contains($0) && (unconfirmed[$0] ?? -1) < 0 })
    var next: String?
    if let active, gone.contains(active), let index = names.firstIndex(of: active) {
      next = names[..<index].last { !gone.contains($0) } ?? names[(index + 1)...].first { !gone.contains($0) }
    }
    let activeGone = active.map(gone.contains) ?? false
    for name in names where gone.contains(name) {
      remove(name)
      change.removed.append(name)
    }
    if activeGone, let next {
      change.evicted += select(next)
      change.newActive = next
    }
    let pending = names.filter { !listedSet.contains($0) }
    names = listedOrder + pending
    if active == nil, !names.isEmpty {
      let choice = Self.initialChoice(listed) ?? names[0]
      change.evicted += select(choice)
      change.newActive = choice
    }
    return change
  }
}
