//! User-defined text snippets: the desktop counterpart of the iOS key-bar macros.

use std::io;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DataDir, macros};

pub const SNIPPETS_FILE: &str = "snippets.json";
pub const MAX_SNIPPETS: usize = 100;
pub const NAME_MAX: usize = 48;
pub const TEXT_MAX: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snippet {
    pub id: Uuid,
    pub name: String,
    /// As typed, with the `macros` escapes.
    pub text: String,
}

impl Snippet {
    /// What goes to the PTY: typed, not pasted, so `\n` runs the command.
    pub fn bytes(&self) -> Vec<u8> {
        macros::expand(&self.text).into_bytes()
    }

    pub fn preview(&self) -> String {
        macros::visible(&macros::expand(&self.text))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SnippetError {
    #[error("Give the snippet a name.")]
    EmptyName,
    #[error("Names are at most {NAME_MAX} characters.")]
    NameTooLong,
    #[error("Type the text the snippet sends.")]
    EmptyText,
    #[error("Snippets are at most {TEXT_MAX} characters.")]
    TextTooLong,
    #[error("At most {MAX_SNIPPETS} snippets.")]
    Full,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Snippets {
    pub items: Vec<Snippet>,
}

/// The first error a form shows, shared by the settings page and `upsert`.
pub fn check(name: &str, text: &str) -> Result<(), SnippetError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(SnippetError::EmptyName);
    }
    if name.chars().count() > NAME_MAX {
        return Err(SnippetError::NameTooLong);
    }
    if text.is_empty() {
        return Err(SnippetError::EmptyText);
    }
    if text.chars().count() > TEXT_MAX {
        return Err(SnippetError::TextTooLong);
    }
    Ok(())
}

/// Lower is a better match; `None` drops the snippet from the palette.
fn rank(s: &Snippet, needle: &str) -> Option<u8> {
    let name = s.name.to_lowercase();
    if name.starts_with(needle) {
        return Some(0);
    }
    if name.contains(needle) {
        return Some(1);
    }
    let mut hay = name.chars();
    if needle.chars().all(|n| hay.any(|h| h == n)) {
        return Some(2);
    }
    s.text.to_lowercase().contains(needle).then_some(3)
}

impl Snippets {
    pub fn load(dir: &DataDir) -> io::Result<Self> {
        let mut s: Snippets = dir.load(SNIPPETS_FILE)?;
        s.items.truncate(MAX_SNIPPETS);
        Ok(s)
    }

    pub fn save(&self, dir: &DataDir) -> io::Result<()> {
        dir.save(SNIPPETS_FILE, self)
    }

    pub fn get(&self, id: Uuid) -> Option<&Snippet> {
        self.items.iter().find(|s| s.id == id)
    }

    /// Adds (`id` is `None`) or replaces a snippet. A name is trimmed; the text is kept as typed.
    pub fn upsert(
        &mut self,
        id: Option<Uuid>,
        name: &str,
        text: &str,
    ) -> Result<Uuid, SnippetError> {
        check(name, text)?;
        let name = name.trim().to_string();
        if let Some(existing) = id.and_then(|id| self.items.iter_mut().find(|s| s.id == id)) {
            existing.name = name;
            existing.text = text.to_string();
            return Ok(existing.id);
        }
        if self.items.len() >= MAX_SNIPPETS {
            return Err(SnippetError::Full);
        }
        let id = id.unwrap_or_else(Uuid::new_v4);
        self.items.push(Snippet {
            id,
            name,
            text: text.to_string(),
        });
        Ok(id)
    }

    pub fn remove(&mut self, id: Uuid) -> bool {
        let before = self.items.len();
        self.items.retain(|s| s.id != id);
        self.items.len() != before
    }

    pub fn move_by(&mut self, id: Uuid, delta: i32) {
        let Some(from) = self.items.iter().position(|s| s.id == id) else {
            return;
        };
        let to = (from as i32 + delta).clamp(0, self.items.len() as i32 - 1) as usize;
        let item = self.items.remove(from);
        self.items.insert(to, item);
    }

    pub fn filter(&self, query: &str) -> Vec<&Snippet> {
        filter_items(&self.items, query)
    }
}

/// The palette list: everything in saved order for an empty query, else the matches, name
/// matches before text matches, saved order within a rank.
pub fn filter_items<'a>(items: &'a [Snippet], query: &str) -> Vec<&'a Snippet> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return items.iter().collect();
    }
    let mut ranked: Vec<(u8, &Snippet)> = items
        .iter()
        .filter_map(|s| rank(s, &needle).map(|r| (r, s)))
        .collect();
    ranked.sort_by_key(|(r, _)| *r);
    ranked.into_iter().map(|(_, s)| s).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Snippets {
        let mut s = Snippets::default();
        s.upsert(None, "Git status", r"git status\n").unwrap();
        s.upsert(None, "Docker logs", r"docker compose logs -f\n")
            .unwrap();
        s.upsert(None, "Interrupt", r"\cC").unwrap();
        s
    }

    fn names(v: Vec<&Snippet>) -> Vec<&str> {
        v.into_iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn bytes_expand_the_escapes_and_preview_shows_them() {
        let s = sample();
        assert_eq!(s.items[0].bytes(), b"git status\r");
        assert_eq!(s.items[0].preview(), "git status⏎");
        assert_eq!(s.items[2].bytes(), vec![3]);
    }

    #[test]
    fn upsert_validates_trims_and_replaces_in_place() {
        let mut s = sample();
        assert_eq!(s.upsert(None, "  ", "x"), Err(SnippetError::EmptyName));
        assert_eq!(s.upsert(None, "n", ""), Err(SnippetError::EmptyText));
        assert_eq!(
            s.upsert(None, &"n".repeat(NAME_MAX + 1), "x"),
            Err(SnippetError::NameTooLong)
        );
        assert_eq!(
            s.upsert(None, "n", &"x".repeat(TEXT_MAX + 1)),
            Err(SnippetError::TextTooLong)
        );
        let id = s.items[1].id;
        assert_eq!(s.upsert(Some(id), "  Logs ", "ls\\n"), Ok(id));
        assert_eq!(s.items[1].name, "Logs");
        assert_eq!(s.items[1].text, "ls\\n");
        assert_eq!(s.items.len(), 3);
    }

    #[test]
    fn the_list_is_capped() {
        let mut s = Snippets::default();
        for i in 0..MAX_SNIPPETS {
            s.upsert(None, &format!("s{i}"), "x").unwrap();
        }
        assert_eq!(s.upsert(None, "one more", "x"), Err(SnippetError::Full));
        let id = s.items[0].id;
        assert!(s.upsert(Some(id), "renamed", "x").is_ok());
    }

    #[test]
    fn remove_and_move_keep_order_sane() {
        let mut s = sample();
        let (a, c) = (s.items[0].id, s.items[2].id);
        s.move_by(c, -1);
        assert_eq!(
            names(s.items.iter().collect()),
            ["Git status", "Interrupt", "Docker logs"]
        );
        s.move_by(a, -5);
        s.move_by(c, 99);
        assert_eq!(
            names(s.items.iter().collect()),
            ["Git status", "Docker logs", "Interrupt"]
        );
        assert!(s.remove(a));
        assert!(!s.remove(a));
        assert_eq!(s.items.len(), 2);
    }

    #[test]
    fn filter_ranks_name_prefix_then_contains_then_letters_then_text() {
        let mut s = Snippets::default();
        s.upsert(None, "Restart nginx", "systemctl restart nginx\\n")
            .unwrap();
        s.upsert(None, "nginx logs", "journalctl -u nginx\\n")
            .unwrap();
        s.upsert(None, "Network", "ip a\\n").unwrap();
        s.upsert(None, "Other", "ping nginx\\n").unwrap();
        assert_eq!(
            names(s.filter("ng")),
            ["nginx logs", "Restart nginx", "Other"]
        );
        assert_eq!(
            names(s.filter("")),
            ["Restart nginx", "nginx logs", "Network", "Other"]
        );
        assert_eq!(
            names(s.filter("  NGINX ")),
            ["nginx logs", "Restart nginx", "Other"]
        );
        assert!(s.filter("zzz").is_empty());
    }

    #[test]
    fn round_trips_and_a_partial_file_loads() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        assert!(Snippets::load(&data).unwrap().items.is_empty());
        let s = sample();
        s.save(&data).unwrap();
        assert_eq!(Snippets::load(&data).unwrap(), s);
        std::fs::write(dir.path().join(SNIPPETS_FILE), "{}").unwrap();
        assert!(Snippets::load(&data).unwrap().items.is_empty());
    }
}
