use std::collections::{HashMap, VecDeque};
use std::num::NonZeroUsize;

pub const DEFAULT_SESSION_CACHE_CAP: usize = 3;

/// One value removed by an LRU touch. The shell owns the value's lifecycle and
/// decides how eviction disconnects a live emulator or transport.
#[derive(Debug, PartialEq, Eq)]
pub struct Evicted<T> {
    pub id: String,
    pub entry: T,
}

impl<T> Evicted<T> {
    fn new(id: impl Into<String>, entry: T) -> Self {
        Self {
            id: id.into(),
            entry,
        }
    }
}

/// Generic LRU bookkeeping for resident terminal sessions.
///
/// TypeScript cached a platform terminal emulator in each entry. Keeping the
/// value generic ports only the policy, so each shell can supply its own live
/// session representation without leaking it into the core.
#[derive(Debug)]
pub struct SessionCache<T> {
    entries: HashMap<String, T>,
    order: VecDeque<String>,
    cap: NonZeroUsize,
}

impl<T> Default for SessionCache<T> {
    fn default() -> Self {
        Self::new(DEFAULT_SESSION_CACHE_CAP)
    }
}

impl<T> SessionCache<T> {
    /// Creates a cache whose internal capacity is always valid. A requested
    /// zero capacity is clamped to one, matching the shipping client.
    pub fn new(cap: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            cap: NonZeroUsize::new(cap).unwrap_or(NonZeroUsize::MIN),
        }
    }

    pub fn get(&self, id: &str) -> Option<&T> {
        self.entries.get(id)
    }

    /// Reads an entry without changing recency. This explicit name keeps
    /// render-time reads distinguishable at shell call sites.
    pub fn peek(&self, id: &str) -> Option<&T> {
        self.entries.get(id)
    }

    pub fn has(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    /// Gets or creates `id`, marks it most recent, and returns a victim when
    /// the capacity is exceeded. Existing entries never call `make` again.
    pub fn touch<F>(&mut self, id: impl Into<String>, make: F) -> Option<Evicted<T>>
    where
        F: FnOnce() -> T,
    {
        let id = id.into();
        if !self.entries.contains_key(&id) {
            self.entries.insert(id.clone(), make());
        }
        self.order.retain(|candidate| candidate != &id);
        self.order.push_front(id);

        if self.order.len() <= self.cap.get() {
            return None;
        }
        let victim = self
            .order
            .pop_back()
            .expect("an over-capacity cache has a least-recent entry");
        self.entries
            .remove(&victim)
            .map(|entry| Evicted::new(victim, entry))
    }

    pub fn delete(&mut self, id: &str) -> Option<T> {
        self.order.retain(|candidate| candidate != id);
        self.entries.remove(id)
    }

    /// Session ids in most-recent-first order.
    pub fn ids(&self) -> Vec<&str> {
        self.order.iter().map(String::as_str).collect()
    }
}

pub fn next_term_id<'a>(existing: impl IntoIterator<Item = &'a str>) -> String {
    let max = existing
        .into_iter()
        .filter_map(|id| id.strip_prefix("term-"))
        .filter(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
        .filter_map(|suffix| suffix.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("term-{}", max.saturating_add(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    struct Entry(&'static str);

    #[test]
    fn touch_creates_an_entry_that_is_retrievable() {
        let mut cache = SessionCache::new(3);
        assert_eq!(cache.touch("term-1", || Entry("1")), None);
        assert_eq!(cache.get("term-1"), Some(&Entry("1")));
        assert!(cache.has("term-1"));
    }

    #[test]
    fn evicts_the_least_recently_touched_entry_beyond_the_cap() {
        let mut cache = SessionCache::new(2);
        cache.touch("a", || Entry("a"));
        cache.touch("b", || Entry("b"));
        cache.touch("a", || Entry("a2"));

        let evicted = cache.touch("c", || Entry("c"));

        assert_eq!(evicted, Some(Evicted::new("b", Entry("b"))));
        assert!(cache.has("a"));
        assert!(cache.has("c"));
        assert!(!cache.has("b"));
        assert_eq!(cache.get("a"), Some(&Entry("a")));
    }

    #[test]
    fn delete_removes_the_entry_and_its_lru_position() {
        let mut cache = SessionCache::new(3);
        cache.touch("x", || Entry("x"));
        assert_eq!(cache.delete("x"), Some(Entry("x")));
        assert!(!cache.has("x"));
        assert!(cache.ids().is_empty());
    }

    #[test]
    fn next_term_id_uses_the_highest_matching_suffix() {
        assert_eq!(next_term_id(std::iter::empty::<&str>()), "term-1");
        assert_eq!(next_term_id(["term-1", "term-3"]), "term-4");
        assert_eq!(next_term_id(["default", "term-2"]), "term-3");
    }

    #[test]
    fn eviction_returns_the_victim_once() {
        let mut cache = SessionCache::new(2);
        assert_eq!(cache.touch("a", || Entry("a")), None);
        assert_eq!(cache.touch("b", || Entry("b")), None);
        assert_eq!(
            cache.touch("c", || Entry("c")),
            Some(Evicted::new("a", Entry("a")))
        );
    }

    #[test]
    fn touching_a_resident_entry_neither_rebuilds_nor_evicts_it() {
        let mut cache = SessionCache::new(3);
        cache.touch("x", || Entry("x"));
        assert_eq!(cache.touch("x", || Entry("x2")), None);
        assert_eq!(cache.get("x"), Some(&Entry("x")));
    }

    #[test]
    fn peek_does_not_reorder_the_lru() {
        let mut cache = SessionCache::new(2);
        cache.touch("a", || Entry("a"));
        cache.touch("b", || Entry("b"));
        assert_eq!(cache.peek("a"), Some(&Entry("a")));

        assert_eq!(
            cache.touch("c", || Entry("c")),
            Some(Evicted::new("a", Entry("a")))
        );
    }

    #[test]
    fn clamps_the_capacity_to_at_least_one() {
        let mut cache = SessionCache::new(0);
        assert_eq!(cache.touch("only", || Entry("only")), None);
        assert!(cache.has("only"));
    }
}
