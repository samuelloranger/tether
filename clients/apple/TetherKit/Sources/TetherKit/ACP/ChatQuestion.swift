import Foundation

/// One value in an elicitation answer: the shape depends on the field it answers.
enum ChatQuestionValue: Codable, Equatable, Sendable {
  case text(String)
  case list([String])
  case flag(Bool)

  var json: Any {
    switch self {
    case let .text(value): return value
    case let .list(values): return values
    case let .flag(value): return value
    }
  }
}

struct ChatQuestionChoice: Codable, Equatable, Sendable {
  var value: String
  var title: String
  var description: String
}

/// The `<name>_custom` property the adapter adds next to a choice field for free text.
struct ChatQuestionCompanion: Codable, Equatable, Sendable {
  var name: String
  var title: String
  var hint: String
}

struct ChatQuestionField: Codable, Equatable, Sendable, Identifiable {
  enum Kind: Codable, Equatable, Sendable {
    case single([ChatQuestionChoice])
    case multi([ChatQuestionChoice])
    case text
    case boolean
  }

  var name: String
  var title: String
  var description: String
  var kind: Kind
  var required: Bool
  var custom: ChatQuestionCompanion?

  var id: String { name }

  var choices: [ChatQuestionChoice] {
    switch kind {
    case let .single(choices), let .multi(choices): return choices
    case .text, .boolean: return []
    }
  }

  func title(for value: String) -> String { choices.first { $0.value == value }?.title ?? value }
}

enum ChatQuestionAction: String, Codable, Equatable, Sendable {
  case accept, decline, cancel
}

struct ChatQuestion: Codable, Equatable, Sendable {
  enum State: Codable, Equatable, Sendable {
    case pending
    case answered([String: ChatQuestionValue])
    case declined
    case cancelled

    init(action: ChatQuestionAction, content: [String: ChatQuestionValue]) {
      switch action {
      case .accept: self = .answered(content)
      case .decline: self = .declined
      case .cancel: self = .cancelled
      }
    }
  }

  var requestId: ACPID
  var toolCallId: String?
  var message: String
  var fields: [ChatQuestionField]
  var state: State = .pending

  static let toolName = "AskUserQuestion"

  var isPending: Bool { state == .pending }

  /// What the host's `acp answers` reports for a request: a choice value, `declined` or `cancelled`.
  func hostState(_ value: String) -> State {
    switch value {
    case "declined": return .declined
    case "cancelled": return .cancelled
    default:
      guard let field = fields.first(where: { $0.isChoice }) ?? fields.first else { return .answered([:]) }
      switch field.kind {
      case .multi: return .answered([field.name: .list([value])])
      case .boolean: return .answered([field.name: .flag(value == "true")])
      case .single, .text: return .answered([field.name: .text(value)])
      }
    }
  }

  /// "red", or "Vitest · Lint, Types" for several fields; nil unless answered.
  var answerSummary: String? {
    guard case let .answered(content) = state else { return nil }
    var parts: [String] = []
    for field in fields {
      var pieces: [String] = []
      switch content[field.name] {
      case let .text(value)?:
        if !value.isEmpty { pieces.append(field.kind == .text ? value : field.title(for: value)) }
      case let .list(values)?:
        pieces.append(contentsOf: values.map(field.title(for:)))
      case let .flag(value)?:
        pieces.append(value ? "Yes" : "No")
      case nil:
        break
      }
      if let custom = field.custom, case let .text(value)? = content[custom.name], !value.isEmpty {
        pieces.append(value)
      }
      if !pieces.isEmpty { parts.append(pieces.joined(separator: ", ")) }
    }
    return parts.isEmpty ? "Answered" : parts.joined(separator: " \u{00B7} ")
  }
}

extension ChatQuestionField {
  var isChoice: Bool {
    switch kind {
    case .single, .multi: return true
    case .text, .boolean: return false
    }
  }
}

/// The agent's `elicitation/create` form request, already reduced to what the chat shows.
struct ACPElicitationRequest: Equatable, Sendable {
  var toolCallId: String?
  var message: String
  var fields: [ChatQuestionField]
}

/// Reads a form's `requestedSchema` without ever failing: an unknown property type is a text field.
enum ChatQuestionSchema {
  private typealias JSON = [String: Any]
  static let customSuffix = "_custom"

  static func fields(from schema: [String: Any]) -> [ChatQuestionField] {
    let properties = schema["properties"] as? JSON ?? [:]
    let required = Set(schema["required"] as? [String] ?? [])
    var parsed = properties.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }.compactMap { name in
      (properties[name] as? JSON).map { field(name: name, property: $0, required: required.contains(name)) }
    }
    var companions: [String: ChatQuestionField] = [:]
    for candidate in parsed where candidate.name.hasSuffix(customSuffix) && candidate.kind == .text {
      let base = String(candidate.name.dropLast(customSuffix.count))
      if parsed.contains(where: { $0.name == base && $0.isChoice }) { companions[base] = candidate }
    }
    parsed.removeAll { field in companions.values.contains { $0.name == field.name } }
    return parsed.map { field in
      guard let companion = companions[field.name] else { return field }
      var merged = field
      merged.custom = ChatQuestionCompanion(
        name: companion.name, title: companion.title, hint: companion.description)
      return merged
    }
  }

  private static func field(name: String, property: JSON, required: Bool) -> ChatQuestionField {
    let type = property["type"] as? String
    var kind = ChatQuestionField.Kind.text
    switch type {
    case "boolean":
      kind = .boolean
    case "array":
      let choices = choices(in: property["items"] as? JSON ?? [:])
      if !choices.isEmpty { kind = .multi(choices) }
    default:
      let choices = choices(in: property)
      if !choices.isEmpty { kind = .single(choices) }
    }
    return ChatQuestionField(
      name: name, title: nonEmpty(property["title"] as? String) ?? name,
      description: property["description"] as? String ?? "", kind: kind, required: required)
  }

  private static func choices(in schema: JSON) -> [ChatQuestionChoice] {
    for key in ["oneOf", "anyOf"] {
      guard let options = schema[key] as? [Any] else { continue }
      let parsed = options.compactMap { option -> ChatQuestionChoice? in
        guard let object = option as? JSON, let value = scalar(object["const"]) else { return nil }
        return ChatQuestionChoice(
          value: value, title: nonEmpty(object["title"] as? String) ?? value,
          description: object["description"] as? String ?? "")
      }
      if !parsed.isEmpty { return parsed }
    }
    guard let values = schema["enum"] as? [Any] else { return [] }
    let names = schema["enumNames"] as? [Any] ?? []
    return values.enumerated().compactMap { index, raw in
      guard let value = scalar(raw) else { return nil }
      let title = index < names.count ? nonEmpty(names[index] as? String) : nil
      return ChatQuestionChoice(value: value, title: title ?? value, description: "")
    }
  }

  private static func scalar(_ value: Any?) -> String? {
    if let text = value as? String { return text }
    guard let number = value as? NSNumber else { return nil }
    return CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "true" : "false") : number.stringValue
  }

  private static func nonEmpty(_ text: String?) -> String? {
    guard let text, !text.isEmpty else { return nil }
    return text
  }
}
