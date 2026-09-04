import Foundation

/// A per-device REST bearer token minted over a host's Noise channel, plus the
/// mint source and bearer-provider glue the REST layer reads it through.
///
/// Tokens are short-lived (~24h) and minted over the already-authenticated Noise
/// session (`NoiseSessionClient.requestToken`). This actor caches one per host in
/// memory, reuses it until it is close to expiry, and re-mints past that point —
/// so a normal REST call never pays a handshake, but a stale token never leaks
/// into a request either.
///
/// Both the clock and the mint are injectable, so the reuse/refresh policy is
/// unit-testable with zero network.
public actor NoiseTokenCache {
  /// Reads the current time. Injectable so tests can advance it deterministically.
  public typealias Clock = @Sendable () -> Date
  /// Mints a fresh token for a host: returns the opaque bearer plus its expiry.
  public typealias Mint = @Sendable (_ hostId: String) async throws -> (token: String, expiresAt: Date)

  /// Refresh once the token is `refreshFraction` of the way through its life, so
  /// a request never rides a token about to expire under it. 0.9 ⇒ refresh in
  /// the last 10% (the spec's "refresh a bit early, e.g. at 90% of lifetime").
  private static let refreshFraction = 0.9

  private struct Entry {
    let token: String
    /// The wall-clock instant at/after which the token should be re-minted.
    let refreshAt: Date
  }

  private var entries: [String: Entry] = [:]
  /// In-flight mints, keyed by host, so concurrent callers share one handshake
  /// instead of each opening their own Noise session.
  private var inflight: [String: Task<String, Error>] = [:]
  private let now: Clock
  private let mint: Mint

  public init(now: @escaping Clock = { Date() }, mint: @escaping Mint) {
    self.now = now
    self.mint = mint
  }

  /// The cached token for `hostId`, minting (and caching) one if none is cached
  /// or the cached one is due for refresh. Concurrent callers coalesce onto a
  /// single mint.
  public func token(for hostId: String) async throws -> String {
    if let entry = entries[hostId], now() < entry.refreshAt {
      return entry.token
    }
    if let existing = inflight[hostId] {
      return try await existing.value
    }
    let task = Task { try await self.mintAndStore(hostId: hostId) }
    inflight[hostId] = task
    defer { inflight[hostId] = nil }
    return try await task.value
  }

  /// Mint a fresh token for a host and cache it with a refresh deadline at
  /// `refreshFraction` of its lifetime. Runs on the actor, so the `entries`
  /// write is serialized with every other access.
  private func mintAndStore(hostId: String) async throws -> String {
    let minted = try await mint(hostId)
    let mintedAt = now()
    let lifetime = minted.expiresAt.timeIntervalSince(mintedAt)
    let refreshAt = lifetime > 0
      ? mintedAt.addingTimeInterval(lifetime * Self.refreshFraction)
      : mintedAt
    entries[hostId] = Entry(token: minted.token, refreshAt: refreshAt)
    return minted.token
  }

  /// Drop the cached token for a host so the next `token(for:)` re-mints. Called
  /// when a REST call is rejected 401 — the token may be revoked or the secret
  /// rotated, and only a fresh mint can tell.
  public func invalidate(hostId: String) {
    entries[hostId] = nil
  }
}

/// Supplies the REST bearer for a host and lets the REST layer invalidate it on
/// a 401. Abstract so `NativeHostClient` need not know whether the value is a
/// password (never invalidated) or a Noise-minted token.
public protocol HostBearerSource: Sendable {
  func currentBearer() async throws -> String
  func invalidateBearer() async
}

/// A `HostBearerSource` backed by a `NoiseTokenCache` entry for one host.
public struct NoiseTokenBearerSource: HostBearerSource {
  private let cache: NoiseTokenCache
  private let hostId: String

  public init(cache: NoiseTokenCache, hostId: String) {
    self.cache = cache
    self.hostId = hostId
  }

  public func currentBearer() async throws -> String {
    try await cache.token(for: hostId)
  }

  public func invalidateBearer() async {
    await cache.invalidate(hostId: hostId)
  }
}
