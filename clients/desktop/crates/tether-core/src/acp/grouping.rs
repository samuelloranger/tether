use std::ops::Range;

use super::reducer::{Item, ItemKind};

/// A run of tool calls reads as one list, so consecutive tool entries share a surface.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Block {
    Item(Item),
    Tools(Vec<Item>),
}

impl Block {
    pub fn id(&self) -> i64 {
        match self {
            Self::Item(item) => item.id,
            Self::Tools(items) => items[0].id,
        }
    }

    pub fn last_id(&self) -> i64 {
        match self {
            Self::Item(item) => item.id,
            Self::Tools(items) => items[items.len() - 1].id,
        }
    }
}

pub fn blocks(items: &[Item]) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut run: Vec<Item> = Vec::new();
    for item in items {
        match item.kind {
            ItemKind::Tool(_) | ItemKind::Permission(_) => run.push(item.clone()),
            _ => {
                if !run.is_empty() {
                    blocks.push(Block::Tools(std::mem::take(&mut run)));
                }
                blocks.push(Block::Item(item.clone()));
            }
        }
    }
    if !run.is_empty() {
        blocks.push(Block::Tools(run));
    }
    blocks
}

/// The recent slice of the transcript that is laid out. The window starts at a block id, so it
/// only grows: new blocks join the end, and "Earlier messages" moves the start back.
pub const PAGE_SIZE: usize = 60;

/// `last_ids` is each block's last item id, in order; `start` is the id the window begins at.
pub fn window_range(last_ids: &[i64], start: Option<i64>) -> Range<usize> {
    let first = start.and_then(|s| last_ids.iter().position(|id| *id >= s));
    match first {
        Some(first) => first..last_ids.len(),
        None => last_ids.len().saturating_sub(PAGE_SIZE)..last_ids.len(),
    }
}

/// Where the window starts once it has been asked for `PAGE_SIZE` more blocks.
pub fn earlier_start(last_ids: &[i64], range: Range<usize>) -> Option<i64> {
    if range.start == 0 {
        return None;
    }
    Some(last_ids[range.start.saturating_sub(PAGE_SIZE)])
}

#[cfg(test)]
mod tests {
    use super::super::message::{ToolFields, ToolKind};
    use super::super::reducer::{Permission, ToolCall};
    use super::*;

    fn tool(id: i64) -> Item {
        Item {
            id,
            kind: ItemKind::Tool(ToolCall::new(&ToolFields::new(&format!("t{id}")))),
        }
    }

    #[test]
    fn consecutive_tool_and_resolved_permission_rows_share_one_block() {
        let resolved = Permission {
            request_id: super::super::message::AcpId::Int(1),
            tool_call_id: "t2".into(),
            title: "Edit".into(),
            kind: ToolKind::Edit,
            diff: None,
            text: None,
            options: vec![],
            resolved_option_id: Some("once".into()),
        };
        let items = vec![
            Item {
                id: 0,
                kind: ItemKind::Notice("hi".into()),
            },
            tool(1),
            Item {
                id: 2,
                kind: ItemKind::Permission(resolved),
            },
            tool(3),
            Item {
                id: 4,
                kind: ItemKind::Assistant {
                    text: "done".into(),
                    message_id: None,
                },
            },
            tool(5),
        ];
        let b = blocks(&items);
        assert_eq!(b.len(), 4);
        let Block::Tools(group) = &b[1] else {
            panic!("expected a tool group")
        };
        assert_eq!(group.iter().map(|i| i.id).collect::<Vec<_>>(), [1, 2, 3]);
        let Block::Tools(last) = &b[3] else {
            panic!("expected a tool group")
        };
        assert_eq!(last.iter().map(|i| i.id).collect::<Vec<_>>(), [5]);
        assert_eq!((b[1].id(), b[1].last_id()), (1, 3));
    }

    fn ids() -> Vec<i64> {
        (0..150).collect()
    }

    #[test]
    fn a_short_transcript_shows_everything() {
        let short: Vec<i64> = (0..10).collect();
        assert_eq!(window_range(&short, None), 0..10);
    }

    #[test]
    fn a_long_transcript_starts_with_the_latest_page() {
        assert_eq!(window_range(&ids(), None), 90..150);
    }

    #[test]
    fn a_pinned_start_keeps_the_window_from_shrinking_as_blocks_arrive() {
        let mut grown = ids();
        grown.extend([150, 151, 152]);
        assert_eq!(window_range(&grown, Some(90)), 90..153);
    }

    #[test]
    fn a_start_that_is_gone_falls_back_to_the_latest_page() {
        assert_eq!(window_range(&ids(), Some(1000)), 90..150);
    }

    #[test]
    fn a_start_inside_a_grouped_block_keeps_the_whole_group() {
        assert_eq!(window_range(&[3, 9, 10, 11], Some(5)), 1..4);
    }

    #[test]
    fn earlier_moves_the_start_back_one_page() {
        assert_eq!(earlier_start(&ids(), 90..150), Some(30));
    }

    #[test]
    fn earlier_stops_at_the_first_block() {
        assert_eq!(earlier_start(&ids(), 30..150), Some(0));
        assert_eq!(earlier_start(&ids(), 0..150), None);
    }
}
