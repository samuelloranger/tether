#if canImport(UIKit)
import UIKit

/// Holds the background task that keeps the app alive long enough to detach.
@MainActor
final class BackgroundDetach {
  private var taskID: UIBackgroundTaskIdentifier = .invalid
  private var work: Task<Void, Never>?

  func begin(controller: SSHTerminalController) {
    end(controller: controller)
    taskID = UIApplication.shared.beginBackgroundTask(withName: "tether.detach") { [weak self] in
      // iOS is taking the time back: let go now rather than stay counted as a viewer.
      Task { @MainActor in
        await controller.suspendNow()
        self?.finish()
      }
    }
    work = Task { [weak self] in
      await controller.detachAfterGrace()
      self?.finish()
    }
  }

  func end(controller: SSHTerminalController) {
    work?.cancel()
    work = nil
    finish()
  }

  private func finish() {
    guard taskID != .invalid else { return }
    UIApplication.shared.endBackgroundTask(taskID)
    taskID = .invalid
  }
}
#endif
