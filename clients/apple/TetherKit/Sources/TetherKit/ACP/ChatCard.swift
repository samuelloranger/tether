import Foundation

struct ChatCard: Codable, Equatable, Sendable {
  struct Hour: Codable, Equatable, Sendable {
    var time: String
    var temperature: Double?
    var conditions: String
    var precipitation: Double?
  }

  struct Container: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var state: String
    var health: String?
    var cpuPercent: Double?
    var memoryBytes: Double?
    var detail: String?
  }

  struct Payload: Codable, Equatable, Sendable {
    var location: String?
    var timeZone: String?
    var unit: String?
    var temperature: Double?
    var feelsLike: Double?
    var conditions: String?
    var hourly: [Hour]?
    var host: String?
    var total: Int?
    var containers: [Container]?
    var alt: String?
  }

  var version: Int
  var id: String
  var revision: Int
  var kind: String
  var title: String
  var fallback: String
  var fetchedAt: String
  var source: String
  var payload: Payload
  var image: ChatImageRef?

  static let marker = "TETHER_CARD_V1\n"

  static func imageBlock(_ value: Any?, depth: Int = 0) -> [String: Any]? {
    guard depth <= 6 else { return nil }
    if let object = value as? [String: Any] {
      if object["type"] as? String == "image" {
        if object["data"] is String { return object }
        if let source = object["source"] as? [String: Any], source["type"] as? String == "base64" {
          return ["type": "image", "data": source["data"] ?? "", "mimeType": source["media_type"] ?? ""]
        }
      }
      return ["result", "content"].lazy.compactMap { imageBlock(object[$0], depth: depth + 1) }.first
    }
    if let array = value as? [Any] { return array.lazy.compactMap { imageBlock($0, depth: depth + 1) }.first }
    return nil
  }

  static let toolName = "tether_publish_card"

  /// Claude names the tool in `name` and `_meta.claudeCode.toolName`, Codex in its title, and an
  /// adapter may mark its own update with `_meta.tether.card`; none of these come from the tool's output.
  static func isPublisher(_ object: [String: Any]) -> Bool {
    let meta = object["_meta"] as? [String: Any]
    let claude = (meta?["claudeCode"] as? [String: Any])?["toolName"] as? String
    if (object["name"] as? String) == "mcp__tether-cards__" + toolName || claude == "mcp__tether-cards__" + toolName {
      return true
    }
    if (object["title"] as? String) == "mcp.tether-cards." + toolName { return true }
    return ((meta?["tether"] as? [String: Any])?["card"] as? Bool) == true
  }

  static func decode(_ value: Any?, images: [ChatImageRef]) -> ChatCard? {
    guard let object = extract(value), JSONSerialization.isValidJSONObject(object),
      let bytes = try? JSONSerialization.data(withJSONObject: object), bytes.count <= 128 * 1024,
      var card = try? JSONDecoder().decode(Self.self, from: bytes), card.valid
    else { return nil }
    card.image = images.first
    return card
  }

  private static func extract(_ value: Any?, depth: Int = 0) -> [String: Any]? {
    guard depth <= 6 else { return nil }
    if let string = value as? String {
      let text = string.hasPrefix(marker) ? String(string.dropFirst(marker.count)) : string
      guard text.utf8.count <= 256 * 1024, let data = text.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data)
      else { return nil }
      if string.hasPrefix(marker) { return parsed as? [String: Any] }
      return extract(parsed, depth: depth + 1)
    }
    if let array = value as? [Any] {
      return array.lazy.compactMap { extract($0, depth: depth + 1) }.first
    }
    if let object = value as? [String: Any] {
      return ["rawOutput", "result", "content", "text"].lazy.compactMap { extract(object[$0], depth: depth + 1) }.first
    }
    return nil
  }

  var supported: Bool { version == 1 && ["weather", "image", "docker"].contains(kind) }

  private var valid: Bool {
    guard !id.isEmpty, id.count <= 128, revision > 0, revision <= Int(Int32.max),
      !title.isEmpty, title.count <= 200, !fallback.isEmpty, fallback.count <= 4000,
      source.count <= 500, fetchedAt.count <= 80
    else { return false }
    guard supported else { return true }
    switch kind {
    case "weather":
      return payload.location != nil && payload.conditions != nil && payload.unit.map { ["C", "F"].contains($0) } == true
        && payload.timeZone.flatMap(TimeZone.init(identifier:)) != nil && (payload.hourly?.count ?? 0) <= 24
        && (payload.hourly ?? []).allSatisfy { $0.precipitation.map { (0...100).contains($0) } ?? true }
    case "docker":
      guard let rows = payload.containers, let total = payload.total, payload.host != nil else { return false }
      return rows.count <= 100 && total >= rows.count && Set(rows.map(\.id)).count == rows.count
        && rows.allSatisfy { !$0.id.isEmpty && !$0.name.isEmpty && ($0.cpuPercent ?? 0) >= 0 && ($0.memoryBytes ?? 0) >= 0 }
    default: return payload.alt != nil
    }
  }

  func request(_ action: String, container: Container? = nil) -> String? {
    guard supported else { return nil }
    func quoted(_ text: String) -> String {
      let data = try? JSONEncoder().encode(text)
      return data.map { String(decoding: $0, as: UTF8.self) } ?? text
    }
    if action == "refresh", kind == "weather" {
      return "Refresh the weather for \(quoted(payload.location ?? ""))."
    }
    guard kind == "docker" else { return nil }
    if action == "refresh" { return "Refresh the Docker status on host \(quoted(payload.host ?? ""))." }
    guard let container, payload.containers?.contains(where: { $0.id == container.id }) == true else { return nil }
    let verb: String
    switch action { case "logs": verb = "Show recent logs for"; case "restart": verb = "Restart"; default: return nil }
    return "\(verb) container \(quoted(container.name)) (\(quoted(container.id))) on host \(quoted(payload.host ?? "")). Update the existing Docker card after checking its current state."
  }

  var actionRequests: [String] {
    var requests = [request("refresh")].compactMap { $0 }
    for container in payload.containers ?? [] {
      requests.append(contentsOf: [request("logs", container: container), request("restart", container: container)].compactMap { $0 })
    }
    return requests
  }
}
