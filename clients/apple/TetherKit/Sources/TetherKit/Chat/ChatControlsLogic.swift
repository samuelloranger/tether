import Foundation

extension ChatFormat {
  /// "$0.16" below one dollar, "$1.2" from one dollar up; other currencies get their code.
  static func cost(_ cost: ChatCost) -> String {
    let amount = max(0, cost.amount)
    let number = amount >= 1 ? String(format: "%.1f", amount) : String(format: "%.2f", amount)
    return cost.currency.uppercased() == "USD" ? "$" + number : number + " " + cost.currency.uppercased()
  }

  /// "2%" for the share of the context window in use; nil when the agent reported no size.
  static func contextPercent(used: Int?, size: Int?) -> String? {
    guard let fraction = contextFraction(used: used, size: size) else { return nil }
    return "\(Int((fraction * 100).rounded()))%"
  }
}

enum ChatModeTint: Equatable {
  case accent, success, secondary, danger

  init(modeId: String?) {
    switch modeId {
    case "plan": self = .accent
    case "acceptEdits": self = .success
    case "bypassPermissions": self = .danger
    default: self = .secondary
    }
  }
}

/// What the header's second line says; empty until the agent has sent its options.
struct ChatStatusLine: Equatable {
  var model: String?
  var mode: String?
  var tint: ChatModeTint = .secondary
  var percent: String?
  var cost: String?

  init(state: ChatState) {
    model = state.currentChoice(of: "model") ?? state.modelId
    mode = state.option(id: "mode").flatMap { Self.shortMode($0.currentValue) } ?? state.currentChoice(of: "mode")
    tint = ChatModeTint(modeId: state.option(id: "mode")?.currentValue)
    percent = ChatFormat.contextPercent(used: state.contextUsed, size: state.contextSize)
    cost = state.cost.map(ChatFormat.cost)
  }

  /// "Bypass permissions" would crowd the model and stats out of the header line.
  static func shortMode(_ value: String) -> String? {
    value == "bypassPermissions" ? "Bypass" : nil
  }

  /// The line only opens the controls once there is something to change.
  var isAvailable: Bool { model != nil || mode != nil }

  var stats: String? {
    let parts = [percent, cost].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  var spoken: String {
    var parts: [String] = []
    if let model { parts.append("Model \(model)") }
    if let mode { parts.append("Mode \(mode)") }
    if let percent { parts.append("Context \(percent) used") }
    if let cost { parts.append("Cost \(cost)") }
    return parts.joined(separator: ", ")
  }
}

enum ChatComposerRule {
  /// Text or at least one encoded image, and nothing still being encoded.
  static func canSend(text: String, readyImages: Int, encoding: Int, sessionCanSend: Bool) -> Bool {
    guard sessionCanSend, encoding == 0 else { return false }
    return readyImages > 0 || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  static let maxImages = 4

  static func message(for error: Error) -> String {
    switch error as? ChatImageError {
    case .tooLarge?: "That image is too large to send."
    case .notAnImage?: "That file isn't an image."
    default: "Couldn't prepare that image."
    }
  }

  static func imageLabel(_ count: Int) -> String { count == 1 ? "1 image" : "\(count) images" }
}

enum ChatQuickCommand: String, CaseIterable {
  case compact, context

  var title: String { rawValue.capitalized }
  var detail: String {
    switch self {
    case .compact: "Summarise the conversation to free context"
    case .context: "Show what is using the context window"
    }
  }
  var text: String { "/" + rawValue }

  /// Shown unless the agent listed its commands and this one is not among them.
  func isOffered(by commands: [ACPCommand]) -> Bool {
    commands.isEmpty || commands.contains { $0.name == rawValue }
  }
}
