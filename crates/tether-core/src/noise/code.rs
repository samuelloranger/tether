//! The 12-char Crockford base32 enrollment code. Generation, input
//! normalization (case + ambiguous-char folding), and display grouping.

use super::NoiseError;

pub const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 12;

pub fn generate() -> String {
    let bytes = ALPHABET.as_bytes();
    let mut raw = [0u8; CODE_LEN];
    getrandom::getrandom(&mut raw).expect("system RNG");
    // Reject-free mapping: 256 % 32 == 0, so a plain modulo is unbiased here.
    raw.iter()
        .map(|b| bytes[(*b as usize) % bytes.len()] as char)
        .collect()
}

pub fn normalize(input: &str) -> Result<String, NoiseError> {
    let mut out = String::with_capacity(CODE_LEN);
    for ch in input.chars() {
        let c = match ch.to_ascii_uppercase() {
            '-' | ' ' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        };
        if !ALPHABET.contains(c) {
            return Err(NoiseError::BadCode);
        }
        out.push(c);
    }
    if out.len() != CODE_LEN {
        return Err(NoiseError::BadCode);
    }
    Ok(out)
}

pub fn grouped(code: &str) -> String {
    code.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_returns_twelve_alphabet_chars() {
        let c = generate();
        assert_eq!(c.len(), CODE_LEN);
        assert!(c.chars().all(|ch| ALPHABET.contains(ch)));
    }

    #[test]
    fn generate_is_not_constant() {
        assert_ne!(generate(), generate());
    }

    #[test]
    fn normalize_folds_case_dashes_and_ambiguous_chars() {
        // lowercase, dashes, spaces, and I/L/O all fold to canonical form.
        assert_eq!(
            normalize("olib-2345-6789").unwrap(), // o->0, l->1, i->1, b->B
            "011B23456789"
        );
    }

    #[test]
    fn normalize_rejects_wrong_length() {
        assert!(matches!(normalize("ABC"), Err(NoiseError::BadCode)));
    }

    #[test]
    fn normalize_rejects_out_of_alphabet() {
        // '!' is not foldable.
        assert!(matches!(
            normalize("!23456789ABC"),
            Err(NoiseError::BadCode)
        ));
    }

    #[test]
    fn grouped_inserts_two_dashes() {
        assert_eq!(grouped("011B23456789"), "011B-2345-6789");
    }
}
