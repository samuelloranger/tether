//! How a notification's text is shaped, whatever shows it.

/// The first two non-empty lines of a body.
pub fn body_lines(body: &str) -> Vec<&str> {
    body.lines().filter(|l| !l.is_empty()).take(2).collect()
}

pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_is_its_first_two_non_empty_lines() {
        assert_eq!(
            body_lines("Claude\n\nNeeds you\nthird"),
            ["Claude", "Needs you"]
        );
        assert!(body_lines("").is_empty());
    }

    #[test]
    fn program_text_is_escaped() {
        assert_eq!(
            escape("a <b> & \"c\" 'd'"),
            "a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;"
        );
    }
}
