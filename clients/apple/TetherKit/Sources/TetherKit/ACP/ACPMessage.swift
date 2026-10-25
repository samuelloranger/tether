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

enum ACPToolKind: String, Equatable, Sendable {
  case read, edit, delete, move, search, execute, think, fetch
  case switchMode = "switch_mode"
  case other
}

enum ACPToolStatus: String, Equatable, Sendable {
  case pending
  case inProgress = "in_progress"
  case completed, failed
}

struct ACPDiff: Equatable, Sendable {
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
}

struct ACPPlanEntry: Equatable, Sendable {
  var content: String
  var status: String
  var priority: String
}

struct ACPPermissionOption: Equatable, Sendable {
  var optionId: String
  var name: String
  var kind: String
}

struct ACPPermissionRequest: Equatable, Sendable {
  var tool: ACPToolFields
  var options: [ACPPermissionOption]
}

enum ACPUpdate: Equatable, Sendable {
  case agentMessage(text: String, messageId: String?)
  case agentThought(text: String)
  case userMessage(text: String)
  case toolCall(ACPToolFields)
  case toolCallUpdate(ACPToolFields)
  case plan([ACPPlanEntry])
  case currentMode(String)
  case sessionInfo(title: String?)
  case usage(used: Int, size: Int)
  case unknown(kind: String)
}

/// Responses carry no method, so one struct holds whichever fields the result had.
struct ACPResult: Equatable, Sendable {
  var loadSession: Bool?
  var sessionId: String?
  var stopReason: String?
}

enum ACPInbound: Equatable, Sendable {
  case response(id: ACPID, result: ACPResult)
  case errorResponse(id: ACPID?, code: Int, message: String)
  case update(ACPUpdate)
  case permissionRequest(id: ACPID, request: ACPPermissionRequest)
  case unknown(method: String?)
}

/// Total: any input, however malformed, decodes to something. One bad line must not end the stream.
enum ACPDecoder {
  private typealias JSON = [String: Any]

  static func decode(_ line: Data) -> ACPInbound {
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
        return .unknown(method: method)
      }
      if method == "session/update", let update = params["update"] as? JSON {
        return .update(decodeUpdate(update))
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
      stopReason: result["stopReason"] as? String)
  }

  private static func decodeUpdate(_ update: JSON) -> ACPUpdate {
    let kind = update["sessionUpdate"] as? String ?? ""
    switch kind {
    case "agent_message_chunk":
      guard let text = contentText(update["content"]) else { return .unknown(kind: kind) }
      return .agentMessage(text: text, messageId: update["messageId"] as? String)
    case "agent_thought_chunk":
      guard let text = contentText(update["content"]) else { return .unknown(kind: kind) }
      return .agentThought(text: text)
    case "user_message_chunk":
      guard let text = contentText(update["content"]) else { return .unknown(kind: kind) }
      return .userMessage(text: text)
    case "tool_call", "tool_call_update":
      guard let fields = toolFields(update) else { return .unknown(kind: kind) }
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
      return .usage(used: used, size: size)
    default:
      return .unknown(kind: kind)
    }
  }

  private static func contentText(_ value: Any?) -> String? {
    guard let block = value as? JSON, block["type"] as? String == "text" else { return nil }
    return block["text"] as? String
  }

  private static func toolFields(_ object: JSON) -> ACPToolFields? {
    guard let id = object["toolCallId"] as? String else { return nil }
    var fields = ACPToolFields(id: id)
    fields.title = object["title"] as? String
    fields.kind = (object["kind"] as? String).flatMap(ACPToolKind.init(rawValue:)) ?? (object["kind"] == nil ? nil : .other)
    fields.status = (object["status"] as? String).flatMap(ACPToolStatus.init(rawValue:))
    var texts: [String] = []
    for item in object["content"] as? [JSON] ?? [] {
      switch item["type"] as? String {
      case "diff":
        fields.diff = ACPDiff(
          path: item["path"] as? String ?? "",
          oldText: item["oldText"] as? String,
          newText: item["newText"] as? String ?? "")
      case "content":
        if let text = contentText(item["content"]) { texts.append(text) }
      default:
        break
      }
    }
    if !texts.isEmpty { fields.text = texts.joined(separator: "\n") }
    switch object["rawOutput"] {
    case let text as String:
      fields.rawOutput = text
    case let other? where !(other is NSNull):
      if JSONSerialization.isValidJSONObject(other),
        let data = try? JSONSerialization.data(withJSONObject: other, options: [.sortedKeys])
      {
        fields.rawOutput = String(decoding: data, as: UTF8.self)
      }
    default:
      break
    }
    return fields
  }

  private static func permission(_ params: JSON) -> ACPPermissionRequest? {
    guard let call = params["toolCall"] as? JSON, let tool = toolFields(call) else { return nil }
    let options = (params["options"] as? [JSON] ?? []).compactMap { option -> ACPPermissionOption? in
      guard let id = option["optionId"] as? String else { return nil }
      return ACPPermissionOption(
        optionId: id, name: option["name"] as? String ?? id, kind: option["kind"] as? String ?? "")
    }
    return ACPPermissionRequest(tool: tool, options: options)
  }
}
