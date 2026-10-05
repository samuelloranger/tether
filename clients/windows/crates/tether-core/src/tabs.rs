use crate::osc::Progress;
use crate::zmx::ZmxSession;

pub const ATTACH_CAP: usize = 12;
pub const DEFAULT_SESSION: &str = "default";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tab {
    pub name: String,
    pub created: i64,
    pub cwd_leaf: Option<String>,
    pub attached: bool,
    pub attention: bool,
    pub last_viewed: u64,
    pub progress: Option<Progress>,
    /// False for a tab created here that `zmx ls` has not reported yet.
    pub on_host: bool,
}

impl Tab {
    fn from_session(s: &ZmxSession) -> Self {
        Tab {
            name: s.name.clone(),
            created: s.created,
            cwd_leaf: s.cwd_leaf().map(str::to_owned),
            attached: false,
            attention: false,
            last_viewed: 0,
            progress: None,
            on_host: true,
        }
    }

    fn local(name: &str) -> Self {
        Tab {
            on_host: false,
            ..Tab::from_session(&ZmxSession {
                name: name.into(),
                created: i64::MAX,
                ..Default::default()
            })
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TabStrip {
    pub tabs: Vec<Tab>,
    pub active: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateOutcome {
    Existing { evicted: Option<String> },
    Created { evicted: Option<String> },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeOutcome {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub active_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillStep {
    pub new_active: Option<String>,
    pub active_changed: bool,
}

pub fn first_tab(sessions: &[ZmxSession]) -> Option<String> {
    if sessions.iter().any(|s| s.name == DEFAULT_SESSION) {
        return Some(DEFAULT_SESSION.to_owned());
    }
    sessions
        .iter()
        .max_by_key(|s| s.created)
        .map(|s| s.name.clone())
}

impl TabStrip {
    pub fn from_sessions(sessions: &[ZmxSession]) -> Self {
        let mut tabs: Vec<Tab> = sessions.iter().map(Tab::from_session).collect();
        tabs.sort_by_key(|t| t.created);
        TabStrip {
            tabs,
            active: first_tab(sessions),
        }
    }

    pub fn from_ls_failure() -> Self {
        TabStrip {
            tabs: vec![Tab::local(DEFAULT_SESSION)],
            active: Some(DEFAULT_SESSION.to_owned()),
        }
    }

    pub fn tab(&self, name: &str) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.name == name)
    }

    pub fn tab_mut(&mut self, name: &str) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.name == name)
    }

    fn index(&self, name: &str) -> Option<usize> {
        self.tabs.iter().position(|t| t.name == name)
    }

    fn active_index(&self) -> Option<usize> {
        self.active.as_deref().and_then(|a| self.index(a))
    }

    /// Makes `name` active and attached. Returns the tab to detach when that goes past the cap.
    pub fn select(&mut self, name: &str, view_tick: u64) -> Option<String> {
        let tab = self.tab_mut(name)?;
        tab.attached = true;
        tab.attention = false;
        tab.last_viewed = view_tick;
        self.active = Some(name.to_owned());
        if self.tabs.iter().filter(|t| t.attached).count() <= ATTACH_CAP {
            return None;
        }
        let victim = self
            .tabs
            .iter_mut()
            .filter(|t| t.attached && t.name != name)
            .min_by_key(|t| t.last_viewed)?;
        victim.attached = false;
        Some(victim.name.clone())
    }

    pub fn create(&mut self, name: &str, view_tick: u64) -> CreateOutcome {
        if self.index(name).is_some() {
            return CreateOutcome::Existing {
                evicted: self.select(name, view_tick),
            };
        }
        self.tabs.push(Tab::local(name));
        CreateOutcome::Created {
            evicted: self.select(name, view_tick),
        }
    }

    pub fn next(&self) -> Option<&str> {
        let len = self.tabs.len();
        if len == 0 {
            return None;
        }
        let i = self.active_index().map_or(0, |i| (i + 1) % len);
        Some(&self.tabs[i].name)
    }

    pub fn prev(&self) -> Option<&str> {
        let len = self.tabs.len();
        if len == 0 {
            return None;
        }
        let i = self.active_index().map_or(len - 1, |i| (i + len - 1) % len);
        Some(&self.tabs[i].name)
    }

    pub fn at_position(&self, one_based: usize) -> Option<&str> {
        one_based
            .checked_sub(1)
            .and_then(|i| self.tabs.get(i))
            .map(|t| t.name.as_str())
    }

    pub fn last(&self) -> Option<&str> {
        self.tabs.last().map(|t| t.name.as_str())
    }

    pub fn new_session_name(&self) -> String {
        if self.tabs.is_empty() {
            return DEFAULT_SESSION.to_owned();
        }
        let mut n = self.tabs.len() + 1;
        while self.index(&format!("session-{n}")).is_some() {
            n += 1;
        }
        format!("session-{n}")
    }

    pub fn mark_attention(&mut self, name: &str) {
        if self.active.as_deref() == Some(name) {
            return;
        }
        if let Some(t) = self.tab_mut(name) {
            t.attention = true;
        }
    }

    pub fn merge(&mut self, sessions: &[ZmxSession]) -> MergeOutcome {
        let mut out = MergeOutcome::default();
        let reported = |name: &str| sessions.iter().any(|s| s.name == name);
        let survives = |t: &Tab| !t.on_host || reported(&t.name);
        let old = std::mem::take(&mut self.tabs);

        let neighbor = self
            .active
            .as_deref()
            .and_then(|a| old.iter().position(|t| t.name == a))
            .filter(|&i| !survives(&old[i]))
            .map(|i| {
                old[..i]
                    .iter()
                    .rev()
                    .find(|t| survives(t))
                    .or_else(|| old[i + 1..].iter().find(|t| survives(t)))
                    .map(|t| t.name.clone())
            });

        for tab in old {
            if survives(&tab) {
                self.tabs.push(tab);
            } else {
                out.removed.push(tab.name);
            }
        }
        for s in sessions {
            match self.tab_mut(&s.name) {
                Some(t) => {
                    t.created = s.created;
                    t.cwd_leaf = s.cwd_leaf().map(str::to_owned);
                    t.on_host = true;
                }
                None => {
                    self.tabs.push(Tab::from_session(s));
                    out.added.push(s.name.clone());
                }
            }
        }
        self.tabs.sort_by_key(|t| t.created);

        if let Some(Some(next)) = neighbor {
            self.active = Some(next);
            out.active_changed = true;
        } else if neighbor.is_some() || self.active.is_none() {
            let next = first_tab(sessions).or_else(|| self.tabs.first().map(|t| t.name.clone()));
            if self.active != next {
                out.active_changed = true;
            }
            self.active = next;
        }
        out
    }

    /// Removes the tab before `zmx kill` runs, so the client has already switched away.
    pub fn begin_kill(&mut self, name: &str) -> KillStep {
        let unchanged = |strip: &Self| KillStep {
            new_active: strip.active.clone(),
            active_changed: false,
        };
        let Some(i) = self.index(name) else {
            return unchanged(self);
        };
        let was_active = self.active.as_deref() == Some(name);
        self.tabs.remove(i);
        if !was_active {
            return unchanged(self);
        }
        let next = if i > 0 {
            Some(i - 1)
        } else if i < self.tabs.len() {
            Some(i)
        } else {
            None
        };
        self.active = next.map(|j| self.tabs[j].name.clone());
        KillStep {
            new_active: self.active.clone(),
            active_changed: true,
        }
    }

    pub fn reattach_order(&self) -> Vec<String> {
        let active = self.active.as_deref();
        let mut order: Vec<String> = self
            .tabs
            .iter()
            .filter(|t| t.attached && Some(t.name.as_str()) == active)
            .map(|t| t.name.clone())
            .collect();
        order.extend(
            self.tabs
                .iter()
                .filter(|t| t.attached && Some(t.name.as_str()) != active)
                .map(|t| t.name.clone()),
        );
        order
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn s(name: &str, created: i64) -> ZmxSession {
        ZmxSession {
            name: name.into(),
            created,
            cwd: format!("/home/u/{name}"),
            ..Default::default()
        }
    }

    pub(super) fn names(strip: &TabStrip) -> Vec<&str> {
        strip.tabs.iter().map(|t| t.name.as_str()).collect()
    }

    #[test]
    fn strip_is_ordered_by_created_oldest_left() {
        let strip = TabStrip::from_sessions(&[s("c", 30), s("a", 10), s("b", 20)]);
        assert_eq!(names(&strip), ["a", "b", "c"]);
        assert_eq!(strip.tabs[0].cwd_leaf.as_deref(), Some("a"));
        assert!(strip.tabs.iter().all(|t| !t.attached && t.on_host));
    }

    #[test]
    fn first_tab_prefers_default_then_newest_then_none() {
        assert_eq!(
            first_tab(&[s("old", 1), s("default", 2), s("new", 3)]).as_deref(),
            Some("default")
        );
        assert_eq!(
            first_tab(&[s("old", 1), s("new", 3), s("mid", 2)]).as_deref(),
            Some("new")
        );
        assert_eq!(first_tab(&[]), None);
        assert_eq!(
            TabStrip::from_sessions(&[s("old", 1), s("new", 3)])
                .active
                .as_deref(),
            Some("new")
        );
        assert_eq!(TabStrip::from_sessions(&[]).active, None);
    }

    #[test]
    fn ls_failure_opens_one_default_tab() {
        let strip = TabStrip::from_ls_failure();
        assert_eq!(names(&strip), ["default"]);
        assert_eq!(strip.active.as_deref(), Some("default"));
        assert!(!strip.tabs[0].on_host);
    }

    #[test]
    fn new_session_name_is_default_then_first_free_session_n() {
        assert_eq!(TabStrip::from_sessions(&[]).new_session_name(), "default");
        let two = TabStrip::from_sessions(&[s("default", 1), s("x", 2)]);
        assert_eq!(two.new_session_name(), "session-3");
        let taken =
            TabStrip::from_sessions(&[s("default", 1), s("session-3", 2), s("session-4", 3)]);
        assert_eq!(taken.new_session_name(), "session-5");
    }

    #[test]
    fn creating_an_existing_name_selects_that_tab() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        assert_eq!(
            strip.create("a", 7),
            CreateOutcome::Existing { evicted: None }
        );
        assert_eq!(strip.tabs.len(), 2);
        assert_eq!(strip.active.as_deref(), Some("a"));
        assert!(strip.tab("a").unwrap().attached);
    }

    #[test]
    fn creating_a_new_name_appends_an_attached_local_tab() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1)]);
        assert_eq!(
            strip.create("fresh", 3),
            CreateOutcome::Created { evicted: None }
        );
        assert_eq!(names(&strip), ["a", "fresh"]);
        let t = strip.tab("fresh").unwrap();
        assert!(t.attached && !t.on_host);
        assert_eq!(strip.active.as_deref(), Some("fresh"));
    }

    #[test]
    fn next_and_prev_wrap() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3)]);
        strip.select("c", 1);
        assert_eq!(strip.next(), Some("a"));
        assert_eq!(strip.prev(), Some("b"));
        strip.select("a", 2);
        assert_eq!(strip.prev(), Some("c"));
        assert_eq!(TabStrip::from_sessions(&[]).next(), None);
    }

    #[test]
    fn positions_are_one_based_and_last_is_the_last_tab() {
        let strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3)]);
        assert_eq!(strip.at_position(1), Some("a"));
        assert_eq!(strip.at_position(3), Some("c"));
        assert_eq!(strip.at_position(4), None);
        assert_eq!(strip.at_position(0), None);
        assert_eq!(strip.last(), Some("c"));
    }

    #[test]
    fn attention_marks_only_background_tabs_and_clears_on_view() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        strip.select("a", 1);
        strip.mark_attention("a");
        strip.mark_attention("b");
        assert!(!strip.tab("a").unwrap().attention);
        assert!(strip.tab("b").unwrap().attention);
        strip.select("b", 2);
        assert!(!strip.tab("b").unwrap().attention);
    }

    #[test]
    fn the_thirteenth_attach_detaches_the_least_recently_viewed() {
        let sessions: Vec<_> = (0..13).map(|i| s(&format!("t{i}"), i)).collect();
        let mut strip = TabStrip::from_sessions(&sessions);
        for i in 0..12 {
            assert_eq!(strip.select(&format!("t{i}"), 100 + i as u64), None);
        }
        strip.select("t0", 200);
        assert_eq!(strip.select("t12", 201).as_deref(), Some("t1"));
        assert!(!strip.tab("t1").unwrap().attached);
        assert_eq!(strip.tabs.iter().filter(|t| t.attached).count(), ATTACH_CAP);
        assert_eq!(strip.select("t1", 202).as_deref(), Some("t2"));
    }

    #[test]
    fn refresh_adds_new_sessions_in_created_order() {
        let mut strip = TabStrip::from_sessions(&[s("a", 10), s("c", 30)]);
        strip.select("a", 1);
        let out = strip.merge(&[s("a", 10), s("b", 20), s("c", 30)]);
        assert_eq!(names(&strip), ["a", "b", "c"]);
        assert_eq!(out.added, ["b"]);
        assert!(out.removed.is_empty() && !out.active_changed);
        assert!(strip.tab("a").unwrap().attached);
    }

    #[test]
    fn active_tab_vanishing_picks_left_then_right_then_none() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3)]);
        strip.select("b", 1);
        let out = strip.merge(&[s("a", 1), s("c", 3)]);
        assert_eq!(out.removed, ["b"]);
        assert!(out.active_changed);
        assert_eq!(strip.active.as_deref(), Some("a"));

        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        strip.select("a", 1);
        strip.merge(&[s("b", 2)]);
        assert_eq!(strip.active.as_deref(), Some("b"));

        strip.merge(&[]);
        assert_eq!(strip.active, None);
        assert!(strip.tabs.is_empty());
    }

    #[test]
    fn vanished_active_with_no_neighbor_picks_the_reported_session() {
        let mut strip = TabStrip::from_sessions(&[s("default", 1)]);
        strip.select("default", 1);
        let out = strip.merge(&[s("session-2", 2)]);
        assert_eq!(strip.active.as_deref(), Some("session-2"));
        assert!(out.active_changed);
    }

    #[test]
    fn refresh_keeps_a_tab_created_here_until_the_host_reports_it() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1)]);
        strip.create("fresh", 1);
        let out = strip.merge(&[s("a", 1)]);
        assert!(out.removed.is_empty());
        assert_eq!(names(&strip), ["a", "fresh"]);
        assert_eq!(strip.active.as_deref(), Some("fresh"));
        strip.merge(&[s("a", 1), s("fresh", 50)]);
        let t = strip.tab("fresh").unwrap();
        assert!(t.on_host && t.attached);
        assert_eq!(t.created, 50);
        strip.merge(&[s("a", 1)]);
        assert!(strip.tab("fresh").is_none());
    }

    #[test]
    fn sessions_appearing_on_an_empty_strip_get_an_active_tab() {
        let mut strip = TabStrip::from_sessions(&[]);
        let out = strip.merge(&[s("phone", 5)]);
        assert!(out.active_changed);
        assert_eq!(strip.active.as_deref(), Some("phone"));
    }

    #[test]
    fn kill_switches_away_first_and_the_last_kill_leaves_empty() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        strip.select("a", 1);
        assert_eq!(
            strip.begin_kill("b"),
            KillStep {
                new_active: Some("a".into()),
                active_changed: false
            }
        );
        assert_eq!(names(&strip), ["a"]);
        assert_eq!(
            strip.begin_kill("a"),
            KillStep {
                new_active: None,
                active_changed: true
            }
        );
        assert!(strip.tabs.is_empty());
        assert_eq!(strip.new_session_name(), "default");
    }

    #[test]
    fn killing_the_active_middle_tab_activates_its_left_neighbor() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3)]);
        strip.select("b", 1);
        assert_eq!(
            strip.begin_kill("b"),
            KillStep {
                new_active: Some("a".into()),
                active_changed: true
            }
        );
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2)]);
        strip.select("a", 1);
        assert_eq!(strip.begin_kill("a").new_active.as_deref(), Some("b"));
    }

    #[test]
    fn reattach_order_is_active_first_then_strip_order() {
        let mut strip = TabStrip::from_sessions(&[s("a", 1), s("b", 2), s("c", 3), s("d", 4)]);
        strip.select("a", 1);
        strip.select("d", 2);
        strip.select("c", 3);
        assert_eq!(strip.reattach_order(), ["c", "a", "d"]);
    }
}
