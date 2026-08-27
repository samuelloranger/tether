import SwiftUI

/// Coloured activity dot + optional "waiting" label for session rows.
/// Pure mapping lives in `SessionActivityLogic`; this is only presentation.
public struct SessionActivityBadge: View {
  public let status: String
  public let activity: String?
  public let live: Bool
  public let showWaitingLabel: Bool

  public init(
    status: String,
    activity: String?,
    live: Bool,
    showWaitingLabel: Bool = true
  ) {
    self.status = status
    self.activity = activity
    self.live = live
    self.showWaitingLabel = showWaitingLabel
  }

  private var key: SessionActivityDot {
    SessionActivityLogic.dotKey(status: status, activity: activity, live: live)
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(SessionActivityLogic.color(for: key))
        .frame(width: 8, height: 8)
        .id(key)
        .transition(.opacity)
        .accessibilityHidden(true)
      if showWaitingLabel, key == .waiting {
        Text("waiting")
          .font(.caption2)
          .foregroundStyle(TetherColors.heatWaiting)
          // The word arrives with the dot's colour rather than after it: the
          // row is answering one question — does this shell need me — and two
          // separately-timed answers read as two events.
          .transition(.opacity)
      }
    }
    .animation(
      TetherMotion.heat(to: LitTheme.state(for: key), reduceMotion: reduceMotion),
      value: key
    )
  }
}
