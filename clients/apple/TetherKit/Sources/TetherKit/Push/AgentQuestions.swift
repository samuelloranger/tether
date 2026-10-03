import Foundation

/// One of Claude's AskUserQuestion questions, as `tether-notify pending` serves it.
public struct AgentQuestion: Decodable, Equatable, Sendable {
  public var question: String
  public var header: String
  public var multiSelect: Bool
  public var options: [AgentQuestionOption]

  public init(question: String, header: String, multiSelect: Bool, options: [AgentQuestionOption]) {
    self.question = question
    self.header = header
    self.multiSelect = multiSelect
    self.options = options
  }
}

public struct AgentQuestionOption: Decodable, Equatable, Sendable {
  public var label: String
  public var description: String?

  public init(label: String, description: String?) {
    self.label = label
    self.description = description
  }
}

/// The held questions, and the state and version an answer to them must name.
public struct PendingQuestions: Decodable, Equatable, Sendable {
  public var session: String
  public var state: String
  public var version: String
  public var kind: String
  public var questions: [AgentQuestion]
}

/// What an Answer… tap opens: the session and the agent state the push was about.
public struct AgentQuestionTarget: Equatable, Identifiable, Sendable {
  public var link: SessionDeepLink
  public var expect: AgentExpectation
  public var id: String { "\(link.identityName)/\(link.sessionId)/\(expect.version)" }
}

/// The answer sheet's picks in progress. A multi-select answer joins its labels in option
/// order with ", ", as Claude Code's own dialog reports one.
public struct AgentQuestionDraft: Equatable, Sendable {
  public let questions: [AgentQuestion]
  public private(set) var selected: [Set<String>]
  public private(set) var other: [String]

  public init(questions: [AgentQuestion]) {
    self.questions = questions
    selected = Array(repeating: [], count: questions.count)
    other = Array(repeating: "", count: questions.count)
  }

  public func isSelected(_ label: String, at index: Int) -> Bool {
    selected[index].contains(label)
  }

  public mutating func toggle(_ label: String, at index: Int) {
    if questions[index].multiSelect {
      if selected[index].contains(label) { selected[index].remove(label) } else { selected[index].insert(label) }
    } else {
      selected[index] = [label]
      other[index] = ""
    }
  }

  /// On a single-choice question the typed answer stands in for a pick.
  public mutating func setOther(_ text: String, at index: Int) {
    other[index] = text
    if !questions[index].multiSelect, !text.trimmingCharacters(in: .whitespaces).isEmpty {
      selected[index] = []
    }
  }

  /// Every question's answer keyed by its text, or nil while one is unanswered.
  public func answers() -> [String: String]? {
    var answers: [String: String] = [:]
    for (index, question) in questions.enumerated() {
      let picks = question.options.map(\.label).filter { selected[index].contains($0) }
      let typed = other[index].trimmingCharacters(in: .whitespacesAndNewlines)
      let parts = typed.isEmpty ? picks : (question.multiSelect ? picks + [typed] : [typed])
      guard !parts.isEmpty else { return nil }
      answers[question.question] = parts.joined(separator: ", ")
    }
    return answers
  }
}
