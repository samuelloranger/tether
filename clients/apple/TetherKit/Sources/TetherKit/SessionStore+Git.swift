import Foundation

/// Git helpers that cannot live in SessionStore.swift (another agent owns that file).
/// Builds a `NativeHostClient` via a fresh `HostStoreAdapter` so we never touch
/// SessionStore's private `hostStore` / `client(for:)`.
///
/// Presentation state (`showGitSheet`) lives on RootView — stored properties
/// cannot be added in an extension.
extension SessionStore {
  public func makeGitClient() -> NativeHostClient? {
    guard let host = activeHost else { return nil }
    let adapter = HostStoreAdapter()
    guard let password = try? adapter.password(for: host.id), !password.isEmpty else {
      return nil
    }
    return NativeHostClient(profile: host, password: password)
  }

  public func loadDiffSummary() async -> DiffSummary? {
    try? await fetchDiffSummary()
  }

  /// Throwing variant, for callers that must tell "no changes" from "could not
  /// look".
  ///
  /// `loadDiffSummary` answers `nil` for both, and the git sheet rendered that
  /// as its empty state — so a server reply of `not a git repository` appeared
  /// on screen as "No uncommitted changes". The two are opposites and a reader
  /// cannot recover one from the other.
  public func fetchDiffSummary() async throws -> DiffSummary {
    guard let sessionId = activeSessionId else { throw GitLoadError.noSession }
    guard let client = makeGitClient() else { throw GitLoadError.noCredentials }
    return try await client.fetchDiffSummary(sessionId: sessionId)
  }

  public func loadFileDiff(
    path: String,
    mode: GitDiffMode
  ) async -> DiffTextResponse? {
    guard let sessionId = activeSessionId, let client = makeGitClient() else { return nil }
    do {
      return try await client.fetchDiff(sessionId: sessionId, path: path, mode: mode)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func gitStage(path: String) async {
    await runGit { client, sessionId in
      try await client.stagePath(sessionId: sessionId, path: path)
    }
  }

  public func gitUnstage(path: String) async {
    await runGit { client, sessionId in
      try await client.unstagePath(sessionId: sessionId, path: path)
    }
  }

  public func gitDiscard(path: String) async {
    await runGit { client, sessionId in
      try await client.discardPath(sessionId: sessionId, path: path)
    }
  }

  public func gitStageAll() async {
    await runGit { client, sessionId in
      try await client.stageAll(sessionId: sessionId)
    }
  }

  public func gitUnstageAll() async {
    await runGit { client, sessionId in
      try await client.unstageAll(sessionId: sessionId)
    }
  }

  public func gitDiscardAll() async {
    await runGit { client, sessionId in
      try await client.discardAll(sessionId: sessionId)
    }
  }

  public func gitCommit(message: String, amend: Bool = false) async -> Bool {
    guard let sessionId = activeSessionId, let client = makeGitClient() else { return false }
    do {
      try await client.commitStaged(sessionId: sessionId, message: message, amend: amend)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func gitStageHunk(path: String, hunkIndex: Int) async {
    await runGit { client, sessionId in
      try await client.stageHunk(sessionId: sessionId, path: path, hunkIndex: hunkIndex)
    }
  }

  public func gitUnstageHunk(path: String, hunkIndex: Int) async {
    await runGit { client, sessionId in
      try await client.unstageHunk(sessionId: sessionId, path: path, hunkIndex: hunkIndex)
    }
  }

  public func loadGitLog(limit: Int = 50) async -> [GitLogEntry]? {
    guard let sessionId = activeSessionId, let client = makeGitClient() else { return nil }
    do {
      return try await client.fetchGitLog(sessionId: sessionId, limit: limit)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func loadCommitDiff(sha: String, path: String? = nil) async -> DiffTextResponse? {
    guard let sessionId = activeSessionId, let client = makeGitClient() else { return nil }
    do {
      return try await client.fetchCommitDiff(sessionId: sessionId, sha: sha, path: path)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func loadDiffBlob(path: String, side: DiffBlobSide) async -> Data? {
    guard let sessionId = activeSessionId, let client = makeGitClient() else { return nil }
    do {
      return try await client.fetchDiffBlob(sessionId: sessionId, path: path, side: side)
    } catch {
      // Absent side is nil (404); other errors surface via errorMessage.
      if case HostClientError.httpStatus(404) = error { return nil }
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func gitUndoLastCommit() async -> Bool {
    guard let sessionId = activeSessionId, let client = makeGitClient() else { return false }
    do {
      try await client.undoLastCommit(sessionId: sessionId)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func gitPushBranch() async -> Bool {
    guard let sessionId = activeSessionId, let client = makeGitClient() else { return false }
    do {
      try await client.pushBranch(sessionId: sessionId)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  private func runGit(
    _ body: (NativeHostClient, String) async throws -> Void
  ) async {
    guard let sessionId = activeSessionId, let client = makeGitClient() else { return }
    do {
      try await body(client, sessionId)
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

/// Why the git sheet has nothing to show, when the reason is not the server's.
public enum GitLoadError: LocalizedError {
  case noSession
  case noCredentials

  public var errorDescription: String? {
    switch self {
    case .noSession: "Open a terminal to see its changes."
    case .noCredentials: "This server needs its password again."
    }
  }
}
