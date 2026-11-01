import Foundation

enum ChatHermes {
  static func conversationName(scope: String) -> String {
    let hash = scope.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { ($0 ^ UInt64($1)) &* 1_099_511_628_211 }
    return "hermes-" + String(hash, radix: 16)
  }

  enum Module: Equatable { case fresh, model, compact, command }

  static func module(for command: ACPCommand) -> Module {
    switch command.name.lowercased() {
    case "new", "reset", "clear": .fresh
    case "model": .model
    case "compress", "compact": .compact
    default: .command
    }
  }

  static func isFresh(_ text: String) -> Bool {
    let token = text.split(whereSeparator: \.isWhitespace).first.map { $0.lowercased() } ?? ""
    return ["/new", "/reset", "/clear"].contains(token)
  }

  static func commandText(_ command: ACPCommand, argument: String) -> String {
    let value = argument.trimmingCharacters(in: .whitespacesAndNewlines)
    return "/" + command.name + (value.isEmpty ? "" : " " + value)
  }
}
