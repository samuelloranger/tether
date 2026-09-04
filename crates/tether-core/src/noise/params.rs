//! Frozen Noise suites + prologue. These are constants, never negotiated:
//! changing a suite means bumping the prologue to a new version that old and
//! new peers refuse to cross.

use snow::params::NoiseParams;

use super::NoiseError;

pub const PAIRING_PATTERN: &str = "Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s";
pub const RECONNECT_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
pub const PROLOGUE: &[u8] = b"tether-noise/1";

pub fn parse(pattern: &str) -> Result<NoiseParams, NoiseError> {
    pattern.parse().map_err(|_| NoiseError::BadParams)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_frozen_patterns_parse() {
        assert!(parse(PAIRING_PATTERN).is_ok());
        assert!(parse(RECONNECT_PATTERN).is_ok());
    }

    #[test]
    fn a_bogus_pattern_is_rejected() {
        assert!(matches!(
            parse("Noise_NOPE_25519"),
            Err(NoiseError::BadParams)
        ));
    }
}
