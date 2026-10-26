/// ACP's `auth_required`.
pub const CODE: i64 = -32000;

const PHRASES: [&str; 10] = [
    "authenticat",
    "unauthorized",
    "not logged in",
    "login",
    "log in",
    "sign in",
    "signed in",
    "credential",
    "invalid api key",
    "oauth",
];

/// Tells "the agent has no login" from every other agent error. The wording covers adapters
/// that report it as a plain error.
pub fn matches_auth_error(code: i64, message: &str) -> bool {
    if code == CODE {
        return true;
    }
    let lower = message.to_lowercase();
    PHRASES.iter().any(|p| lower.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_or_the_wording_matches() {
        assert!(matches_auth_error(-32000, ""));
        assert!(matches_auth_error(1, "Please Log In first"));
        assert!(matches_auth_error(1, "Invalid API key"));
        assert!(!matches_auth_error(1, "boom"));
    }
}
