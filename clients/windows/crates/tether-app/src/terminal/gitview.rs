//! The repository panel's Slint side: model state in, properties out, callbacks back as messages.

use slint::{ComponentHandle, ModelRc, SharedString, VecModel};
use tether_core::git::MergeMethod;
use tether_core::gitpanel::{DiffLine, DiffLineKind, GitMsg, GitTab, GitView, PrView, Tone};
use tether_core::markdown::ItemKind;

use crate::terminal::model::Msg;
use crate::{AppWindow, CheckVm, DiffLineVm, GitRowVm, GitVm, MdItemVm, MdLinkVm, MethodVm};

/// A mono glyph at the diff's 12px size, plus the gutters.
const GLYPH_PX: f32 = 7.4;
const GUTTER_PX: f32 = 40.0 + 44.0 + 18.0 + 100.0;
const WIDTH_SCAN_CAP: usize = 400;

pub fn tone_index(t: Tone) -> i32 {
    match t {
        Tone::Neutral => 0,
        Tone::Good => 1,
        Tone::Bad => 2,
        Tone::Warn => 3,
        Tone::Accent => 4,
    }
}

pub fn tab_index(t: GitTab) -> i32 {
    match t {
        GitTab::Changes => 0,
        GitTab::Commits => 1,
        GitTab::PullRequests => 2,
        GitTab::Docs => 3,
    }
}

pub fn tab_from_index(i: i32) -> GitTab {
    match i {
        1 => GitTab::Commits,
        2 => GitTab::PullRequests,
        3 => GitTab::Docs,
        _ => GitTab::Changes,
    }
}

pub fn method_id(m: MergeMethod) -> i32 {
    match m {
        MergeMethod::Merge => 0,
        MergeMethod::Squash => 1,
        MergeMethod::Rebase => 2,
    }
}

pub fn method_from_id(id: i32) -> MergeMethod {
    match id {
        0 => MergeMethod::Merge,
        2 => MergeMethod::Rebase,
        _ => MergeMethod::Squash,
    }
}

fn line_kind(k: DiffLineKind) -> i32 {
    match k {
        DiffLineKind::File => 0,
        DiffLineKind::Hunk => 1,
        DiffLineKind::Added => 2,
        DiffLineKind::Removed => 3,
        DiffLineKind::Context => 4,
        DiffLineKind::Plain => 5,
    }
}

fn item_kind(k: ItemKind) -> i32 {
    match k {
        ItemKind::Heading => 0,
        ItemKind::Paragraph => 1,
        ItemKind::Bullet => 2,
        ItemKind::Numbered => 3,
        ItemKind::Code => 4,
        ItemKind::Quote => 5,
        ItemKind::Rule => 6,
    }
}

/// Logical pixels the widest line needs, so the list can scroll sideways.
pub fn diff_width(lines: &[DiffLine]) -> f32 {
    let widest = lines
        .iter()
        .map(|l| l.text.chars().take(WIDTH_SCAN_CAP).count())
        .max()
        .unwrap_or(0);
    widest as f32 * GLYPH_PX + GUTTER_PX
}

fn model<T: Clone + 'static>(items: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(items))
}

fn set_pr(vm: &GitVm<'_>, pr: Option<&PrView>) {
    let empty = PrView::default();
    let p = pr.unwrap_or(&empty);
    vm.set_has_pr(pr.is_some());
    vm.set_pr_title(p.title.as_str().into());
    vm.set_pr_branches(p.branches.as_str().into());
    vm.set_pr_state(p.state_chip.as_str().into());
    vm.set_pr_state_tone(tone_index(p.state_tone));
    vm.set_pr_chips(model(
        p.chips
            .iter()
            .map(|c| SharedString::from(c.as_str()))
            .collect(),
    ));
    vm.set_pr_loading(p.loading);
    vm.set_checks_headline(p.checks_headline.as_str().into());
    vm.set_checks_tone(tone_index(p.checks_tone));
    vm.set_checks(model(
        p.checks
            .iter()
            .map(|c| CheckVm {
                name: c.name.as_str().into(),
                tone: tone_index(c.tone),
                linked: c.linked,
            })
            .collect(),
    ));
    vm.set_gate_text(p.gate_text.as_str().into());
    vm.set_gate_tone(tone_index(p.gate_tone));
    vm.set_can_merge(p.can_merge);
    vm.set_merge_label(p.merge_label.as_str().into());
    vm.set_pr_status(p.status.as_str().into());
    vm.set_pr_status_tone(tone_index(p.status_tone));
    vm.set_pr_note(p.note.as_str().into());
    let dialog = p.dialog.as_ref();
    vm.set_dialog_open(dialog.is_some());
    vm.set_dialog_title(dialog.map_or("", |d| d.title.as_str()).into());
    vm.set_dialog_body(dialog.map_or("", |d| d.body.as_str()).into());
    vm.set_dialog_methods(model(
        dialog
            .map(|d| {
                d.methods
                    .iter()
                    .map(|(m, label, selected)| MethodVm {
                        id: method_id(*m),
                        label: label.as_str().into(),
                        selected: *selected,
                    })
                    .collect()
            })
            .unwrap_or_default(),
    ));
}

pub fn apply(w: &AppWindow, v: GitView) {
    let vm = w.global::<GitVm>();
    vm.set_open(v.open);
    vm.set_modal(
        v.open && (v.markdown.is_some() || v.pr.as_ref().is_some_and(|p| p.dialog.is_some())),
    );
    vm.set_title(v.title.as_str().into());
    vm.set_subtitle(v.subtitle.as_str().into());
    vm.set_notice(v.notice.as_str().into());
    vm.set_toast(v.toast.as_str().into());
    vm.set_tab(tab_index(v.tab));
    vm.set_show_tabs(v.show_tabs);
    vm.set_can_back(v.can_back);
    vm.set_loading(v.loading);
    vm.set_rows(model(
        v.rows
            .iter()
            .map(|r| GitRowVm {
                primary: r.primary.as_str().into(),
                secondary: r.secondary.as_str().into(),
                badge: r.badge.as_str().into(),
                tone: tone_index(r.tone),
                added: r.added as i32,
                removed: r.removed as i32,
                previewable: r.previewable,
            })
            .collect(),
    ));
    vm.set_diff_width(diff_width(&v.diff));
    vm.set_diff(model(
        v.diff
            .iter()
            .map(|l| DiffLineVm {
                kind: line_kind(l.kind),
                old_no: l.old.as_str().into(),
                new_no: l.new.as_str().into(),
                text: l.text.as_str().into(),
                stat: l.stat.as_str().into(),
            })
            .collect(),
    ));
    set_pr(&vm, v.pr.as_ref());
    let md = v.markdown.as_ref();
    vm.set_md_open(md.is_some());
    vm.set_md_title(md.map_or("", |m| m.title.as_str()).into());
    vm.set_md_loading(md.is_some_and(|m| m.loading));
    vm.set_md_error(md.map_or("", |m| m.error.as_str()).into());
    vm.set_md_truncated(md.is_some_and(|m| m.truncated));
    vm.set_md_items(model(
        md.map(|m| {
            m.items
                .iter()
                .map(|i| MdItemVm {
                    kind: item_kind(i.kind),
                    level: i32::from(i.level),
                    text: i.text.as_str().into(),
                    links: model(
                        i.links
                            .iter()
                            .map(|l| MdLinkVm {
                                label: l.label.as_str().into(),
                                url: l.url.as_str().into(),
                            })
                            .collect(),
                    ),
                })
                .collect()
        })
        .unwrap_or_default(),
    ));
}

fn send(m: GitMsg) {
    if let Some(sink) = crate::terminal::glue::current() {
        sink(Msg::Git(m));
    }
}

/// Wired once per window: like the rest of the terminal's callbacks, they route through the
/// current sink, so opening another machine only swaps what is behind them.
pub fn wire(ui: &AppWindow) {
    let vm = ui.global::<GitVm>();
    vm.on_toggle(|| send(GitMsg::Toggle));
    vm.on_close(|| send(GitMsg::Close));
    vm.on_refresh(|| send(GitMsg::Refresh));
    vm.on_set_tab(|i| send(GitMsg::SetTab(tab_from_index(i))));
    vm.on_back(|| send(GitMsg::Back));
    vm.on_row(|i| send(GitMsg::Row(i.max(0) as usize)));
    vm.on_row_alt(|i| send(GitMsg::RowAlt(i.max(0) as usize)));
    vm.on_review(|| send(GitMsg::ReviewPr));
    vm.on_open_pr(|| send(GitMsg::OpenPr));
    vm.on_open_check(|i| send(GitMsg::OpenCheck(i.max(0) as usize)));
    vm.on_merge_ask(|| send(GitMsg::MergeAsk));
    vm.on_merge_method(|id| send(GitMsg::MergeMethod(method_from_id(id))));
    vm.on_merge_confirm(|| send(GitMsg::MergeConfirm));
    vm.on_merge_cancel(|| send(GitMsg::MergeCancel));
    vm.on_close_md(|| send(GitMsg::CloseMarkdown));
    vm.on_open_link(|url| send(GitMsg::OpenLink(url.into())));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> DiffLine {
        DiffLine {
            kind: DiffLineKind::Context,
            old: String::new(),
            new: String::new(),
            text: text.into(),
            stat: String::new(),
        }
    }

    #[test]
    fn tabs_round_trip_through_their_indices() {
        for tab in [
            GitTab::Changes,
            GitTab::Commits,
            GitTab::PullRequests,
            GitTab::Docs,
        ] {
            assert_eq!(tab_from_index(tab_index(tab)), tab);
        }
        assert_eq!(tab_from_index(99), GitTab::Changes);
    }

    #[test]
    fn merge_methods_round_trip_and_an_unknown_id_is_the_default_squash() {
        for m in [MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase] {
            assert_eq!(method_from_id(method_id(m)), m);
        }
        assert_eq!(method_from_id(-4), MergeMethod::Squash);
    }

    #[test]
    fn the_diff_is_as_wide_as_its_longest_line_and_never_narrower_than_the_gutters() {
        assert_eq!(diff_width(&[]), GUTTER_PX);
        let wide = diff_width(&[line("ab"), line(&"x".repeat(100))]);
        assert!((wide - (100.0 * GLYPH_PX + GUTTER_PX)).abs() < 0.01);
        let capped = diff_width(&[line(&"x".repeat(10_000))]);
        assert!((capped - (WIDTH_SCAN_CAP as f32 * GLYPH_PX + GUTTER_PX)).abs() < 0.01);
    }
}
