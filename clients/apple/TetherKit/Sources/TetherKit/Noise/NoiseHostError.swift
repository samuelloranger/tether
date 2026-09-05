import Foundation

public enum NoiseHostError: Error, Equatable {
  /// `createNoiseHost` could not find the paired key material under the pairing
  /// id — pairing did not complete, so no profile is created.
  case missingPairedKeys
}
