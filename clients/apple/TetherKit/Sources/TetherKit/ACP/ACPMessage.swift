import Foundation

enum ACPID: Hashable, Codable, Sendable {
  case int(Int)
  case string(String)

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(Int.self) {
      self = .int(value)
    } else {
      self = .string(try container.decode(String.self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case let .int(value): try container.encode(value)
    case let .string(value): try container.encode(value)
    }
  }

  var json: Any {
    switch self {
    case let .int(value): return value
    case let .string(value): return value
    }
  }
}

enum ACPToolKind: String, Codable, Equatable, Sendable {
  case read, edit, delete, move, search, execute, think, fetch
  case switchMode = "switch_mode"
  case other
}

enum ACPToolStatus: String, Codable, Equatable, Sendable {
  case pending
  case inProgress = "in_progress"
  case completed, failed
}

struct ACPDiff: Codable, Equatable, Sendable {
  var path: String
  var oldText: String?
  var newText: String
}

/// A tool call as the agent sent it; every field but the id is optional because
/// `tool_call_update` carries only what changed.
struct ACPToolFields: Equatable, Sendable {
  var id: String
  var title: String?
  var kind: ACPToolKind?
  var status: ACPToolStatus?
  var diff: ACPDiff?
  var text: String?
  var rawOutput: String?
  /// Image blocks of the call's content, already handed to the image store.
  var images: [ChatImageRef]?
  /// `_meta.claudeCode.toolName`, which tells a subagent launch ("Agent", older "Task") from any other call.
  var toolName: String?
  /// `_meta.claudeCode.parentToolUseId`: set on a subagent's own tool calls.
  var parentId: String?
  /// Scalar fields of `rawInput`, stringified; a subagent launch fills them in progressively.
  var input: [String: String]?
}

struct ACPPlanEntry: Codable, Equatable, Sendable {
  var content: String
  var status: String
  var priority: String
}

struct ACPPermissionOption: Codable, Equatable, Sendable {
  var optionId: String
  var name: String
  var kind: String
}

struct ACPPermissionRequest: Equatable, Sendable {
  var tool: ACPToolFields
  var options: [ACPPermissionOption]
}

struct ACPConfigChoice: Codable, Equatable, Sendable {
  var value: String
  var name: String
  var description: String
}

/// A select-type session setting such as mode, model or effort; `currentValue` is one of the choices' values.
struct ACPConfigOption: Codable, Equatable, Sendable, Identifiable {
  var id: String
  var name: String
  var description: String
  var category: String?
  var currentValue: String
  var choices: [ACPConfigChoice]
}

struct ACPCommand: Codable, Equatable, Sendable, Identifiable {
  var name: String
  var description: String
  /// Present when the command takes arguments.
  var hint: String?
  var id: String { name }
}

struct ChatCost: Codable, Equatable, Sendable {
  var amount: Double
  var currency: String
}

enum ACPUpdate: Equatable, Sendable {
  case agentMessage(text: String, messageId: String?)
  case agentImage(ChatImageRef, messageId: String?)
  case agentThought(text: String)
  case userMessage(text: String, messageId: String? = nil)
  case toolCall(ACPToolFields)
  case toolCallUpdate(ACPToolFields)
  case plan([ACPPlanEntry])
  case currentMode(String)
  case sessionInfo(title: String?)
  case usage(used: Int, size: Int, cost: ChatCost?, modelId: String?)
  case configOptions([ACPConfigOption])
  case commands([ACPCommand])
  case unknown(kind: String)
}

/// Responses carry no method, so one struct holds whichever fields the result had.
struct ACPResult: Equatable, Sendable {
  var loadSession: Bool?
  var sessionId: String?
  var stopReason: String?
  var configOptions: [ACPConfigOption]?
}

enum ACPInbound: Equatable, Sendable {
  case response(id: ACPID, result: ACPResult)
  case errorResponse(id: ACPID?, code: Int, message: String)
  case update(ACPUpdate)
  case permissionRequest(id: ACPID, request: ACPPermissionRequest)
  case elicitation(id: ACPID, request: ACPElicitationRequest)
  /// The adapter's `_auth/status_update`: whether the host's agent has a login. Sent at session start and
  /// again when a queued prompt begins.
  case authStatus(signedIn: Bool)
  /// A line another client attached to the same holder sent (`_tether/client`).
  case clientEcho(client: String, line: ACPClientLine)
  case unknown(method: String?)
}

/// Total: any input, however malformed, decodes to something. One bad line must not end the stream.
enum ACPDecoder {
  private typealias JSON = [String: Any]

  /// Image bytes in the line go to `images` (when given) and only references come out.
  static func decode(_ line: Data, images: (any ChatImageSink)? = nil) -> ACPInbound {
    guard let object = (try? JSONSerialization.jsonObject(with: line)) as? JSON else {
      return .unknown(method: nil)
    }
    let id = parseID(object["id"])
    if let method = object["method"] as? String {
      let params = object["params"] as? JSON ?? [:]
      if id != nil {
        if method == "session/request_permission", let id, let request = permission(params) {
          return .permissionRequest(id: id, request: request)
        }
        if method == "elicitation/create", let id { return .elicitation(id: id, request: elicitation(params)) }
        return .unknown(method: method)
      }
      if method == "session/update", let update = params["update"] as? JSON {
        return .update(decodeUpdate(update, images: images))
      }
      if method == ACPClientLine.echoMethod, let client = params["client"] as? String,
        let line = params["message"] as? JSON
      {
        return .clientEcho(client: client, line: clientLine(line))
      }
      if method == "_auth/status_update", let status = (params["authStatus"] as? JSON)?["kind"] as? String {
        return .authStatus(signedIn: status != "none")
      }
      return .unknown(method: method)
    }
    if let error = object["error"] as? JSON {
      return .errorResponse(
        id: id, code: error["code"] as? Int ?? 0, message: error["message"] as? String ?? "")
    }
    if let id, object.keys.contains("result") {
      return .response(id: id, result: decodeResult(object["result"] as? JSON ?? [:]))
    }
    return .unknown(method: nil)
  }

  private static func clientLine(_ line: JSON) -> ACPClientLine {
    let id = parseID(line["id"])
    switch line["method"] as? String {
    case "session/prompt":
      let params = line["params"] as? JSON
      let blocks = params?["prompt"] as? [JSON] ?? []
      let text = blocks.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined()
      return .prompt(
        id: id, text: text, imageCount: blocks.filter { $0["type"] as? String == "image" }.count,
        sessionId: params?["sessionId"] as? String)
    case "session/load":
      return .load(sessionId: (line["params"] as? JSON)?["sessionId"] as? String)
    case "session/cancel":
      return .cancel
    case .some:
      return .other
    case nil:
      guard let id, let result = line["result"] as? JSON else { return .other }
      if let outcome = result["outcome"] as? JSON {
        switch outcome["outcome"] as? String {
        case "selected": return (outcome["optionId"] as? String).map { .permissionAnswer(id: id, optionId: $0) } ?? .other
        case "cancelled": return .permissionAnswer(id: id, optionId: "cancelled")
        default: return .other
        }
      }
      guard let action = (result["action"] as? String).flatMap(ChatQuestionAction.init(rawValue:)) else { return .other }
      let content = (result["content"] as? JSON ?? [:]).compactMapValues(questionValue)
      return .questionAnswer(id: id, action: action, content: content)
    }
  }

  private static func questionValue(_ value: Any) -> ChatQuestionValue? {
    if let flag = value as? Bool, CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() { return .flag(flag) }
    if let text = value as? String { return .text(text) }
    if let number = value as? NSNumber { return .text(number.stringValue) }
    if let list = value as? [Any] {
      let strings = list.compactMap { $0 as? String }
      return strings.count == list.count ? .list(strings) : nil
    }
    return nil
  }

  private static func parseID(_ value: Any?) -> ACPID? {
    if let number = value as? Int { return .int(number) }
    if let string = value as? String { return .string(string) }
    return nil
  }

  private static func decodeResult(_ result: JSON) -> ACPResult {
    let capabilities = result["agentCapabilities"] as? JSON
    return ACPResult(
      loadSession: capabilities?["loadSession"] as? Bool,
      sessionId: result["sessionId"] as? String,
      stopReason: result["stopReason"] as? String,
      configOptions: (result["configOptions"] as? [JSON]).map(configOptions))
  }

  private static func decodeUpdate(_ update: JSON, images: (any ChatImageSink)?) -> ACPUpdate {
    let kind = update["sessionUpdate"] as? String ?? ""
    switch kind {
    case "agent_message_chunk":
      if let block = update["content"] as? JSON, block["type"] as? String == "image" {
        guard let ref = imageRef(block, images) else { return .unknown(kind: kind) }
        return .agentImage(ref, messageId: update["messageId"] as? String)
      }
      guard let text = contentText(update["content"]) else { return .unknown(kind: kind) }
      return .agentMessage(text: text, messageId: update["messageId"] as? String)
    case "agent_thought_chunk":
      guard let text = contentText(update["content"]) else { return .unknown(kind: kind) }
      return .agentThought(text: text)
    case "user_message_chunk":
      guard let text = contentText(update["content"]) else { return .unknown(kind: kind) }
      return .userMessage(text: text, messageId: update["messageId"] as? String)
    case "tool_call", "tool_call_update":
      guard let fields = toolFields(update, images: images) else { return .unknown(kind: kind) }
      return kind == "tool_call" ? .toolCall(fields) : .toolCallUpdate(fields)
    case "plan":
      let entries = (update["entries"] as? [JSON] ?? []).map {
        ACPPlanEntry(
          content: $0["content"] as? String ?? "",
          status: $0["status"] as? String ?? "pending",
          priority: $0["priority"] as? String ?? "medium")
      }
      return .plan(entries)
    case "current_mode_update":
      guard let mode = update["currentModeId"] as? String else { return .unknown(kind: kind) }
      return .currentMode(mode)
    case "session_info_update":
      return .sessionInfo(title: update["title"] as? String)
    case "usage_update":
      guard let used = update["used"] as? Int, let size = update["size"] as? Int else {
        return .unknown(kind: kind)
      }
      var cost: ChatCost?
      if let raw = update["cost"] as? JSON, let amount = (raw["amount"] as? NSNumber)?.doubleValue {
        cost = ChatCost(amount: amount, currency: raw["currency"] as? String ?? "USD")
      }
      let modelId = (update["_meta"] as? JSON)?["_claude/model"] as? String
      return .usage(used: used, size: size, cost: cost, modelId: modelId)
    case "config_option_update":
      guard let raw = update["configOptions"] as? [JSON] else { return .unknown(kind: kind) }
      return .configOptions(configOptions(raw))
    case "available_commands_update":
      guard let raw = update["availableCommands"] as? [JSON] else { return .unknown(kind: kind) }
      return .commands(raw.compactMap { command in
        guard let name = command["name"] as? String, !name.isEmpty else { return nil }
        let hint = (command["input"] as? JSON)?["hint"] as? String
        return ACPCommand(name: name, description: command["description"] as? String ?? "", hint: hint)
      })
    default:
      return .unknown(kind: kind)
    }
  }

  private static func configOptions(_ raw: [JSON]) -> [ACPConfigOption] {
    raw.compactMap { option in
      guard (option["type"] as? String ?? "select") == "select",
        let id = option["id"] as? String, let current = option["currentValue"] as? String
      else { return nil }
      let choices = (option["options"] as? [JSON] ?? []).compactMap { choice -> ACPConfigChoice? in
        guard let value = choice["value"] as? String else { return nil }
        return ACPConfigChoice(
          value: value, name: choice["name"] as? String ?? value, description: choice["description"] as? String ?? "")
      }
      return ACPConfigOption(
        id: id, name: option["name"] as? String ?? id, description: option["description"] as? String ?? "",
        category: option["category"] as? String, currentValue: current, choices: choices)
    }
  }

  private static func contentText(_ value: Any?) -> String? {
    guard let block = value as? JSON, block["type"] as? String == "text" else { return nil }
    return block["text"] as? String
  }

  /// A block that is not an image, not base64, or too large is skipped; the stream carries on.
  private static func imageRef(_ block: JSON, _ sink: (any ChatImageSink)?) -> ChatImageRef? {
    guard let encoded = block["data"] as? String,
      let prepared = ChatImageIntake.prepare(base64: encoded, mimeType: block["mimeType"] as? String)
    else { return nil }
    sink?.write(prepared.data, for: prepared.ref)
    return prepared.ref
  }

  /// An image result as raw output (or its JSON text): the content already carries the picture.
  private static func isImagePayload(_ value: Any) -> Bool {
    if let items = value as? [Any] { return items.contains(where: isImagePayload) }
    guard let object = value as? JSON else { return false }
    if object["type"] as? String == "image" { return true }
    return (object["source"] as? JSON)?["type"] as? String == "base64"
  }

  private static func toolFields(_ object: JSON, images sink: (any ChatImageSink)? = nil, collectImages: Bool = true) -> ACPToolFields? {
    guard let id = object["toolCallId"] as? String else { return nil }
    var fields = ACPToolFields(id: id)
    fields.title = object["title"] as? String
    let meta = (object["_meta"] as? JSON)?["claudeCode"] as? JSON
    fields.toolName = meta?["toolName"] as? String
    fields.parentId = meta?["parentToolUseId"] as? String
    if let input = object["rawInput"] as? JSON {
      var scalars: [String: String] = [:]
      for (key, value) in input {
        if let text = value as? String {
          scalars[key] = text
        } else if let number = value as? NSNumber {
          scalars[key] = CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "true" : "false") : number.stringValue
        }
      }
      if !scalars.isEmpty { fields.input = scalars }
    }
    fields.kind = (object["kind"] as? String).flatMap(ACPToolKind.init(rawValue:)) ?? (object["kind"] == nil ? nil : .other)
    fields.status = (object["status"] as? String).flatMap(ACPToolStatus.init(rawValue:))
    var texts: [String] = []
    var refs: [ChatImageRef] = []
    for item in object["content"] as? [JSON] ?? [] {
      switch item["type"] as? String {
      case "diff":
        fields.diff = ACPDiff(
          path: item["path"] as? String ?? "",
          oldText: item["oldText"] as? String,
          newText: item["newText"] as? String ?? "")
      case "content":
        if let text = contentText(item["content"]) {
          if !ChatToolDetail.looksLikeBlob(text) { texts.append(text) }
        } else if collectImages, let block = item["content"] as? JSON, block["type"] as? String == "image",
          let ref = imageRef(block, sink)
        {
          refs.append(ref)
        }
      default:
        break
      }
    }
    if !texts.isEmpty { fields.text = texts.joined(separator: "\n") }
    if !refs.isEmpty { fields.images = refs }
    switch object["rawOutput"] {
    case let text as String:
      if !ChatToolDetail.looksLikeBlob(text) { fields.rawOutput = text }
    case let other? where !(other is NSNull):
      if !isImagePayload(other), JSONSerialization.isValidJSONObject(other),
        let data = try? JSONSerialization.data(withJSONObject: other, options: [.sortedKeys])
      {
        fields.rawOutput = String(decoding: data, as: UTF8.self)
      }
    default:
      break
    }
    return fields
  }

  /// A malformed form still becomes a question the user can decline: the agent waits for a reply either way.
  private static func elicitation(_ params: JSON) -> ACPElicitationRequest {
    let message = params["message"] as? String ?? ""
    return ACPElicitationRequest(
      toolCallId: params["toolCallId"] as? String,
      message: message.isEmpty ? "The agent has a question." : message,
      fields: ChatQuestionSchema.fields(from: params["requestedSchema"] as? JSON ?? [:]))
  }

  private static func permission(_ params: JSON) -> ACPPermissionRequest? {
    guard let call = params["toolCall"] as? JSON, let tool = toolFields(call, collectImages: false) else { return nil }
    let options = (params["options"] as? [JSON] ?? []).compactMap { option -> ACPPermissionOption? in
      guard let id = option["optionId"] as? String else { return nil }
      return ACPPermissionOption(
        optionId: id, name: option["name"] as? String ?? id, kind: option["kind"] as? String ?? "")
    }
    return ACPPermissionRequest(tool: tool, options: options)
  }
}
