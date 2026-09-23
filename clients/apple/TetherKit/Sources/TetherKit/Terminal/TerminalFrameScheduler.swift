import QuartzCore
import UIKit

/// Pulling at the display's rate coalesces an output burst into one evenly paced frame;
/// the link pauses after a few idle ticks so an inactive terminal costs nothing.
final class TerminalFrameScheduler: NSObject {
  /// Returns whether the tick had anything to do.
  private let onFrame: () -> Bool
  private var link: CADisplayLink?
  private var idleTicks = 0

  /// Long enough that a stream of small writes never pays the restart cost,
  /// short enough that an idle session stops waking the display link.
  private static let maxIdleTicks = 6

  init(onFrame: @escaping () -> Bool) {
    self.onFrame = onFrame
    super.init()
  }

  deinit {
    link?.invalidate()
  }

  func requestFrame() {
    idleTicks = 0
    if link == nil { start() }
    link?.isPaused = false
  }

  func stop() {
    link?.invalidate()
    link = nil
  }

  private func start() {
    let link = CADisplayLink(target: self, selector: #selector(tick))
    // Without this the range defaults to the display's minimum and a ProMotion
    // panel is left running the terminal at 60Hz.
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  @objc private func tick() {
    if onFrame() {
      idleTicks = 0
      return
    }
    idleTicks += 1
    if idleTicks > Self.maxIdleTicks {
      link?.isPaused = true
    }
  }
}
