import CryptoKit
import Foundation

/// The 12-char Crockford base32 enrollment code — the exact client-side mirror
/// of `crates/tether-core/src/noise/code.rs`. Input normalization (case + dash +
/// ambiguous-char folding) and display grouping have to agree byte-for-byte with
/// the core, because the core is what actually derives the PSK from the code.
///
/// Pure value logic, no SwiftUI: the segmented field, paste handling, and QR
/// parsing all sit on top of these functions, and the unit tests drive them
/// directly.
public enum PairingCode {
  /// Crockford base32 — 0-9 and A-Z minus I, L, O, U.
  public static let alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  public static let length = 12

  /// Fold one input character the way the core does: uppercase, drop dashes and
  /// spaces (`nil`), map the ambiguous glyphs onto their canonical digit. The
  /// returned character is NOT guaranteed to be in the alphabet — `U`/`!` fold to
  /// themselves and are rejected downstream. `nil` means "skip this character".
  static func fold(_ ch: Character) -> Character? {
    switch Character(ch.uppercased()) {
    case "-", " ":
      return nil
    case "O":
      return "0"
    case "I", "L":
      return "1"
    case let other:
      return other
    }
  }

  /// Strict normalization — the validation gate. Mirrors `code::normalize`:
  /// returns the canonical 12-char, dashless, uppercase code, or `nil` if any
  /// character folds to something outside the alphabet or the length is wrong.
  /// This is the form handed to `NoiseSessionClient.pair(code:)`.
  public static func normalize(_ input: String) -> String? {
    var out = ""
    out.reserveCapacity(length)
    for ch in input {
      guard let folded = fold(ch) else { continue }
      guard alphabet.contains(folded) else { return nil }
      out.append(folded)
    }
    return out.count == length ? out : nil
  }

  /// Lenient input filter for the live segmented field: fold, keep only alphabet
  /// characters (silently dropping anything else, e.g. a mistyped `U` or a URL a
  /// user pasted char by char), and cap at `length`. Never fails — it just
  /// yields the best canonical prefix so the field can render it.
  public static func sanitize(_ input: String) -> String {
    var out = ""
    out.reserveCapacity(length)
    for ch in input {
      guard let folded = fold(ch), alphabet.contains(folded) else { continue }
      out.append(folded)
      if out.count == length { break }
    }
    return out
  }

  /// Group any dashless code (partial or complete) into `XXXX-XXXX-XXXX`.
  /// Mirrors `code::grouped`. A partial code groups what it has: `7QF4KM9` →
  /// `7QF4-KM9`.
  public static func group(_ code: String) -> String {
    stride(from: 0, to: code.count, by: 4).map { start -> String in
      let from = code.index(code.startIndex, offsetBy: start)
      let to = code.index(from, offsetBy: min(4, code.count - start))
      return String(code[from ..< to])
    }.joined(separator: "-")
  }

  /// Normalize then group — the canonical display form (`7QF4-KM9P-X3TV`), or
  /// `nil` when the input is not a valid code.
  public static func formatted(_ input: String) -> String? {
    normalize(input).map(group)
  }

  public static func isValid(_ input: String) -> Bool {
    normalize(input) != nil
  }
}

/// A pairing payload decoded from a QR code. Either the bare 12-char code, or a
/// `tether://pair?code=…&host=…` deep link. `code` is always the canonical
/// dashless form; `host` is the optional pre-filled server address.
public struct PairPayload: Equatable {
  public let code: String
  public let host: String?

  public init(code: String, host: String?) {
    self.code = code
    self.host = host
  }

  /// Parse a scanned QR payload. Accepts:
  ///   1. `tether://pair?code=7QF4-KM9P-X3TV&host=https://box:8085`
  ///   2. the raw code, with or without dashes (`7QF4KM9PX3TV`)
  /// Returns `nil` when no valid code can be recovered.
  public static func parse(_ raw: String) -> PairPayload? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    // Deep-link form. `tether://pair?...` parses with "pair" as the host.
    if let components = URLComponents(string: trimmed),
       components.scheme?.lowercased() == "tether" {
      let items = components.queryItems ?? []
      guard let rawCode = items.first(where: { $0.name == "code" })?.value,
            let code = PairingCode.normalize(rawCode) else {
        return nil
      }
      let host = items.first(where: { $0.name == "host" })?.value
      let cleanedHost = host?.trimmingCharacters(in: .whitespacesAndNewlines)
      return PairPayload(code: code, host: (cleanedHost?.isEmpty ?? true) ? nil : cleanedHost)
    }

    // Bare code form.
    guard let code = PairingCode.normalize(trimmed) else { return nil }
    return PairPayload(code: code, host: nil)
  }
}

/// A short, human-comparable fingerprint of a 32-byte Noise static key. SHA-256
/// of the key, first 8 bytes, uppercase hex grouped in fours
/// (`A1B2-C3D4-E5F6-0718`). Deterministic, so it is unit-tested and so two people
/// can read it aloud to confirm they pinned the same server.
public enum NoiseFingerprint {
  /// Compact 8-byte prefix (uppercase, dash-grouped) for tight glance contexts.
  public static func short(_ key: Data) -> String {
    let hex = SHA256.hash(data: key).prefix(8).map { String(format: "%02X", $0) }.joined()
    return groupedByFour(hex, separator: "-")
  }

  /// The full SHA-256 as lowercase hex grouped in fours. Byte-identical (modulo
  /// spaces) to the host's `serverFingerprint` and `tether pair`'s printed
  /// "Server fingerprint", so the user can eyeball the SAME string on both ends.
  public static func full(_ key: Data) -> String {
    let hex = SHA256.hash(data: key).map { String(format: "%02x", $0) }.joined()
    return groupedByFour(hex, separator: " ")
  }

  private static func groupedByFour(_ hex: String, separator: String) -> String {
    stride(from: 0, to: hex.count, by: 4).map { start -> String in
      let from = hex.index(hex.startIndex, offsetBy: start)
      let to = hex.index(from, offsetBy: 4)
      return String(hex[from ..< to])
    }.joined(separator: separator)
  }
}
