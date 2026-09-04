//! PSK derivation: Argon2id(code, fixed salt) -> 32 bytes. Fixed salt is sound
//! because the code is a 60-bit single-use random value (see spec). Argon2id
//! only makes each guess expensive.

use argon2::{Algorithm, Argon2, Params, Version};

use super::NoiseError;

pub const PAIR_SALT: &[u8] = b"tether-noise-pair/1";

// Parameters: 64 MiB memory, 3 passes, 1 lane, 32-byte output. Tune in review;
// target ~100 ms on a low-end host.
const M_COST_KIB: u32 = 65536;
const T_COST: u32 = 3;
const P_COST: u32 = 1;

pub fn derive(normalized_code: &str) -> Result<[u8; 32], NoiseError> {
    let params = Params::new(M_COST_KIB, T_COST, P_COST, Some(32)).map_err(|_| NoiseError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(normalized_code.as_bytes(), PAIR_SALT, &mut out)
        .map_err(|_| NoiseError::Kdf)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic_and_32_bytes() {
        let a = derive("011B23456789").unwrap();
        let b = derive("011B23456789").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn different_codes_derive_different_psks() {
        assert_ne!(derive("011B23456789").unwrap(), derive("011B2345678A").unwrap());
    }
}
