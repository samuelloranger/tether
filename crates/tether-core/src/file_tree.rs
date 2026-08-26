//! Nested folder tree from flat file paths — port of `apps/mobile/src/diffModel.ts`
//! `buildFileTree` plus collapse-key helpers used by the FileTree UI.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// Flat file row that feeds the tree (git diff stats or plain workspace entries).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FileTreeNode {
    Dir {
        name: String,
        path: String,
        children: Vec<FileTreeNode>,
    },
    File {
        name: String,
        path: String,
        file: FileStat,
    },
}

impl FileTreeNode {
    pub fn path(&self) -> &str {
        match self {
            Self::Dir { path, .. } | Self::File { path, .. } => path,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Dir { name, .. } | Self::File { name, .. } => name,
        }
    }
}

#[derive(Default)]
struct DirBuilder {
    name: String,
    path: String,
    dirs: BTreeMap<String, DirBuilder>,
    files: Vec<FileStat>,
}

/// Builds a real nested folder tree from flat file paths (like a file explorer).
/// Children are sorted: directories first, then files, each group alphabetically
/// by name (case-insensitive).
pub fn build_file_tree(files: &[FileStat]) -> Vec<FileTreeNode> {
    let mut root = DirBuilder::default();
    for file in files {
        let segments: Vec<&str> = file.path.split('/').filter(|s| !s.is_empty()).collect();
        if segments.is_empty() {
            continue;
        }
        let mut current = &mut root;
        let mut current_path = String::new();
        for (i, segment) in segments.iter().enumerate() {
            let is_last = i == segments.len() - 1;
            current_path = if current_path.is_empty() {
                (*segment).to_string()
            } else {
                format!("{current_path}/{segment}")
            };
            if is_last {
                current.files.push(file.clone());
            } else {
                current = current
                    .dirs
                    .entry((*segment).to_string())
                    .or_insert_with(|| DirBuilder {
                        name: (*segment).to_string(),
                        path: current_path.clone(),
                        dirs: BTreeMap::new(),
                        files: Vec::new(),
                    });
            }
        }
    }
    finish_tree(root)
}

fn finish_tree(builder: DirBuilder) -> Vec<FileTreeNode> {
    let mut nodes: Vec<FileTreeNode> = builder
        .dirs
        .into_values()
        .map(|dir| FileTreeNode::Dir {
            name: dir.name.clone(),
            path: dir.path.clone(),
            children: finish_tree(dir),
        })
        .collect();
    for file in builder.files {
        let name = file
            .path
            .rsplit('/')
            .next()
            .unwrap_or(file.path.as_str())
            .to_string();
        nodes.push(FileTreeNode::File {
            name,
            path: file.path.clone(),
            file,
        });
    }
    nodes.sort_by(|a, b| match (a, b) {
        (FileTreeNode::Dir { .. }, FileTreeNode::File { .. }) => std::cmp::Ordering::Less,
        (FileTreeNode::File { .. }, FileTreeNode::Dir { .. }) => std::cmp::Ordering::Greater,
        _ => a.name().to_lowercase().cmp(&b.name().to_lowercase()),
    });
    nodes
}

/// Collapse key used when twin trees (e.g. staged/unstaged) must stay independent.
/// Mirrors `reviewDiffKey` when `scope` is set; otherwise the bare path.
pub fn collapse_key(scope: Option<&str>, path: &str) -> String {
    match scope {
        Some(scope) => format!("{scope}:{path}"),
        None => path.to_string(),
    }
}

/// Toggle membership of `key` in a collapsed-dirs set.
pub fn toggle_collapsed(collapsed: &mut BTreeSet<String>, key: String) {
    if !collapsed.remove(&key) {
        collapsed.insert(key);
    }
}

pub fn is_collapsed(collapsed: &BTreeSet<String>, key: &str) -> bool {
    collapsed.contains(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(path: &str, insertions: u32, deletions: u32) -> FileStat {
        FileStat {
            path: path.to_string(),
            insertions,
            deletions,
            binary: false,
            staged: None,
        }
    }

    #[test]
    fn nests_folders_like_a_real_file_tree() {
        let files = [
            stat("src/a.ts", 1, 0),
            stat("README.md", 1, 0),
            stat("src/b.ts", 0, 1),
            stat("src/nested/c.ts", 2, 0),
        ];
        let tree = build_file_tree(&files);
        assert_eq!(tree.len(), 2);
        assert!(matches!(tree[0], FileTreeNode::Dir { .. }));
        assert!(matches!(tree[1], FileTreeNode::File { .. }));
        match &tree[0] {
            FileTreeNode::Dir {
                name,
                path,
                children,
            } => {
                assert_eq!(name, "src");
                assert_eq!(path, "src");
                assert_eq!(children.len(), 3);
                assert!(matches!(
                    &children[0],
                    FileTreeNode::Dir {
                        name: n,
                        path: p,
                        ..
                    } if n == "nested" && p == "src/nested"
                ));
                assert!(matches!(
                    &children[1],
                    FileTreeNode::File { name: n, path: p, .. } if n == "a.ts" && p == "src/a.ts"
                ));
                assert!(matches!(
                    &children[2],
                    FileTreeNode::File { name: n, path: p, .. } if n == "b.ts" && p == "src/b.ts"
                ));
            }
            _ => panic!("expected src dir"),
        }
        match &tree[1] {
            FileTreeNode::File { name, path, .. } => {
                assert_eq!(name, "README.md");
                assert_eq!(path, "README.md");
            }
            _ => panic!("expected README.md"),
        }
    }

    #[test]
    fn reuses_the_same_folder_node_across_siblings() {
        let files = [
            stat("src/a.ts", 1, 0),
            stat("src/nested/c.ts", 2, 0),
            stat("src/b.ts", 0, 1),
        ];
        let tree = build_file_tree(&files);
        assert_eq!(tree.len(), 1);
        match &tree[0] {
            FileTreeNode::Dir { children, .. } => assert_eq!(children.len(), 3),
            _ => panic!("expected one root dir"),
        }
    }

    #[test]
    fn collapse_key_scopes_twin_trees() {
        assert_eq!(collapse_key(Some("staged"), "x.ts"), "staged:x.ts");
        assert_eq!(collapse_key(Some("unstaged"), "x.ts"), "unstaged:x.ts");
        assert_eq!(collapse_key(None, "x.ts"), "x.ts");
    }

    #[test]
    fn toggle_collapsed_inserts_and_removes() {
        let mut set = BTreeSet::new();
        toggle_collapsed(&mut set, "src".into());
        assert!(is_collapsed(&set, "src"));
        toggle_collapsed(&mut set, "src".into());
        assert!(!is_collapsed(&set, "src"));
    }

    #[test]
    fn skips_empty_paths() {
        let files = [stat("", 0, 0), stat("ok.ts", 1, 0)];
        let tree = build_file_tree(&files);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].path(), "ok.ts");
    }
}
