#if canImport(UIKit)
import QuartzCore
import UIKit

/// Vsync-aligned frame pacing for the terminal surface.
///
/// Output used to drive the redraw directly: every WebSocket frame that changed
/// the grid decoded a snapshot and invalidated the view. A chatty program does
/// that dozens of times between two vsyncs, so most of the work was thrown away
/// and what survived arrived at an uneven cadence — which is exactly what reads
/// as "not 60fps". Pulling at the display's own rate coalesces the burst into
/// one frame and makes the cadence even.
///
/// The link pauses itself after a few idle ticks so an inactive terminal costs
/// nothing, and unpauses the moment new bytes land.
/// `NSObject` because `CADisplayLink` takes an `@objc` selector target.
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
#endif
