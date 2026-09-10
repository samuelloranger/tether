import Foundation

/// Tool inputs are arbitrary JSON. Codable can't hand us the raw bytes for one
/// key mid-decode, so we decode into this and re-serialize to a pretty string
/// the card can show verbatim.
public indirect enum AgentJSONValue: Decodable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([AgentJSONValue])
  case object([String: AgentJSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([AgentJSONValue].self) {
      self = .array(a)
    } else if let o = try? c.decode([String: AgentJSONValue].self) {
      self = .object(o)
    } else {
      throw DecodingError.dataCorruptedError(
        in: c, debugDescription: "unrepresentable JSON value")
    }
  }

  private var foundation: Any {
    switch self {
    case let .string(s): return s
    case let .number(n): return n
    case let .bool(b): return b
    case .null: return NSNull()
    case let .array(a): return a.map(\.foundation)
    case let .object(o): return o.mapValues(\.foundation)
    }
  }

  public var prettyString: String {
    if case let .string(s) = self { return s }
    let value = foundation
    guard JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(
        withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
      let str = String(data: data, encoding: .utf8)
    else { return String(describing: value) }
    return str
  }
}
