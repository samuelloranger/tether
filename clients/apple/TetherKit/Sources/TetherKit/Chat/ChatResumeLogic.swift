import Foundation

/// When a stored snapshot may be resumed, and what a lost stream means afterwards.
enum ChatResume {
  struct Attempt: Equatable {
    var offset: Int
    var identity: Int
  }

  enum AfterLoss: Equatable {
    /// The resume did not take: drop the snapshot and replay from zero.
    case replayFromZero
    case ended
    case lost
  }

  static func identity(of summary: ACPChatSummary) -> Int { Int(summary.created.timeIntervalSince1970) }

  /// Any doubt returns nil, which means a clean replay from zero.
  static func usable(_ snapshot: ChatSnapshot?, journal: ChatJournal, summary: ACPChatSummary?) -> ChatSnapshot? {
    guard let snapshot, let summary, snapshot.offset > 0,
      snapshot.identity == identity(of: summary), snapshot.offset <= summary.logBytes,
      snapshot.isConsistent(with: journal)
    else { return nil }
    return snapshot
  }

  /// `summary` is the host's view after the loss, nil when it could not be read. A resume that
  /// got nothing and ended is only trusted as "nothing new" when the host's log still reaches the
  /// offset (the daemon drops an attach whose `--from` is past its log).
  static func afterLoss(attempt: Attempt?, receivedBytes: Int, failedDecoding: Bool, summary: ACPChatSummary?) -> AfterLoss {
    if let attempt {
      if failedDecoding { return .replayFromZero }
      if receivedBytes <= attempt.offset, let summary,
        identity(of: summary) != attempt.identity || summary.logBytes < attempt.offset
      {
        return .replayFromZero
      }
    }
    return summary?.isRunning == false ? .ended : .lost
  }
}
