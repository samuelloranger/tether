use super::message::Command;

/// How many commands the palette lists by default.
pub const DEFAULT_LIMIT: usize = 20;

/// The filter text while the draft is still just a command name: "/co" gives "co", "/" gives "".
pub fn query(draft: &str) -> Option<&str> {
    let rest = draft.strip_prefix('/')?;
    if rest.chars().any(char::is_whitespace) {
        None
    } else {
        Some(rest)
    }
}

fn ordered(mut list: Vec<&Command>) -> Vec<&Command> {
    list.sort_by_cached_key(|c| c.name.to_lowercase());
    list
}

/// Name prefix first, then name contains, then description contains; each tier alphabetical.
pub fn matches(query: &str, commands: &[Command], limit: usize) -> Vec<Command> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return ordered(commands.iter().collect())
            .into_iter()
            .take(limit)
            .cloned()
            .collect();
    }
    let mut prefix = Vec::new();
    let mut in_name = Vec::new();
    let mut in_description = Vec::new();
    for command in commands {
        let name = command.name.to_lowercase();
        if name.starts_with(&needle) {
            prefix.push(command);
        } else if name.contains(&needle) {
            in_name.push(command);
        } else if command.description.to_lowercase().contains(&needle) {
            in_description.push(command);
        }
    }
    ordered(prefix)
        .into_iter()
        .chain(ordered(in_name))
        .chain(ordered(in_description))
        .take(limit)
        .cloned()
        .collect()
}

/// What the composer shows after the user picks a command; the flag keeps the keyboard up for arguments.
pub fn insertion(command: &Command) -> (String, bool) {
    (format!("/{} ", command.name), command.hint.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands() -> Vec<Command> {
        let c = |name: &str, description: &str, hint: Option<&str>| Command {
            name: name.into(),
            description: description.into(),
            hint: hint.map(String::from),
        };
        vec![
            c("review", "Review a PR", Some("<pr>")),
            c(
                "compact",
                "Clear history, keep a summary",
                Some("<instructions>"),
            ),
            c("context", "Show context usage", None),
            c("config", "Open settings", None),
            c("recompute", "Redo", None),
            c("model", "Switch the model", Some("<model>")),
            c("zebra", "Uses the compact path", None),
        ]
    }

    fn names(found: Vec<Command>) -> Vec<String> {
        found.into_iter().map(|c| c.name).collect()
    }

    #[test]
    fn query_exists_only_while_the_draft_is_a_bare_command_name() {
        assert_eq!(query("/"), Some(""));
        assert_eq!(query("/co"), Some("co"));
        assert_eq!(query("/compact now"), None);
        assert_eq!(query("/compact "), None);
        assert_eq!(query("/a\nb"), None);
        assert_eq!(query("hello /co"), None);
        assert_eq!(query(" /co"), None);
        assert_eq!(query(""), None);
    }

    #[test]
    fn matches_rank_prefix_then_name_then_description_case_insensitively() {
        let all = commands();
        let co = ["compact", "config", "context", "recompute", "zebra"];
        assert_eq!(names(matches("co", &all, 20)), co);
        assert_eq!(names(matches("CO", &all, 20)), co);
        assert_eq!(names(matches("sum", &all, 20)), ["compact"]);
        assert_eq!(names(matches("mod", &all, 20)), ["model"]);
        assert_eq!(names(matches("re", &all, 20)), ["recompute", "review"]);
        assert_eq!(
            names(matches("mp", &all, 20)),
            ["compact", "recompute", "zebra"]
        );
    }

    #[test]
    fn a_bare_slash_lists_everything_alphabetically_and_limit_applies() {
        let all = commands();
        assert_eq!(
            names(matches("", &all, 20)),
            [
                "compact",
                "config",
                "context",
                "model",
                "recompute",
                "review",
                "zebra"
            ]
        );
        assert_eq!(names(matches("", &all, 2)), ["compact", "config"]);
        assert!(matches("zzz", &all, 20).is_empty());
    }

    #[test]
    fn insertion_adds_a_trailing_space_and_flags_commands_that_take_input() {
        let all = commands();
        assert_eq!(insertion(&all[1]), ("/compact ".to_string(), true));
        assert_eq!(insertion(&all[2]), ("/context ".to_string(), false));
    }
}
