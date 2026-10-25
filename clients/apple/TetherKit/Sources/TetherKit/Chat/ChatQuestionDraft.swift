import Foundation

/// What the user has entered in a question card so far, and the rules for submitting it.
struct ChatQuestionDraft: Equatable {
  /// Chosen values per field, in the order they were picked.
  private(set) var picked: [String: [String]] = [:]
  private(set) var typed: [String: String] = [:]
  private(set) var flags: [String: Bool] = [:]
  private(set) var customOpen: Set<String> = []

  func isPicked(_ field: ChatQuestionField, _ value: String) -> Bool {
    picked[field.name]?.contains(value) ?? false
  }

  func text(_ name: String) -> String { typed[name] ?? "" }
  func flag(_ name: String) -> Bool { flags[name] ?? false }

  mutating func choose(_ field: ChatQuestionField, _ value: String) {
    switch field.kind {
    case .single:
      picked[field.name] = [value]
    case .multi:
      var values = picked[field.name] ?? []
      if let index = values.firstIndex(of: value) { values.remove(at: index) } else { values.append(value) }
      picked[field.name] = values
    case .text, .boolean:
      break
    }
  }

  mutating func setText(_ name: String, _ value: String) { typed[name] = value }
  mutating func setFlag(_ name: String, _ value: Bool) { flags[name] = value }
  mutating func openCustom(_ name: String) { customOpen.insert(name) }

  private func custom(_ field: ChatQuestionField) -> String {
    field.custom.map { text($0.name).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
  }

  /// One question with one single-select field and no free text typed: a tap on an option is the answer.
  func submitsOnTap(_ fields: [ChatQuestionField]) -> Bool {
    guard fields.count == 1, case .single = fields[0].kind else { return false }
    return custom(fields[0]).isEmpty
  }

  /// The form values an accept sends. Fields left empty are left out.
  func content(_ fields: [ChatQuestionField]) -> [String: ChatQuestionValue] {
    var content: [String: ChatQuestionValue] = [:]
    for field in fields {
      switch field.kind {
      case .single:
        if let value = picked[field.name]?.first { content[field.name] = .text(value) }
      case .multi(let choices):
        let chosen = picked[field.name] ?? []
        let ordered = choices.map(\.value).filter(chosen.contains)
        if !ordered.isEmpty { content[field.name] = .list(ordered) }
      case .text:
        let value = text(field.name).trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { content[field.name] = .text(value) }
      case .boolean:
        content[field.name] = .flag(flag(field.name))
      }
      if let companion = field.custom, !custom(field).isEmpty { content[companion.name] = .text(custom(field)) }
    }
    return content
  }

  /// Every required field has an answer, and something is answered at all: an empty accept
  /// reads to the agent as "did not answer". A boolean always counts as answered.
  func canSubmit(_ fields: [ChatQuestionField]) -> Bool {
    let answers = content(fields)
    for field in fields where field.required {
      let given = answers[field.name] != nil || field.custom.map { answers[$0.name] != nil } ?? false
      if !given { return false }
    }
    return fields.isEmpty || !answers.isEmpty
  }
}
