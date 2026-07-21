import Feather from '@expo/vector-icons/Feather';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { FileTreeNode } from './diffModel';

const INDENT = 16;

// Renders a real nested folder tree (like a file explorer) — folders indent
// their contents one level deeper instead of listing full path prefixes.
export interface FileAction {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  destructive?: boolean;
  onPress: (path: string) => void;
}

export function FileTree({
  nodes,
  depth = 0,
  collapsedDirs,
  onToggleDir,
  onSelectFile,
  fileActions,
}: {
  nodes: FileTreeNode[];
  depth?: number;
  collapsedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  // Inline per-file actions (stage/unstage/discard) shown after the stats.
  fileActions?: FileAction[];
}) {
  const { theme } = useAppTheme();
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'dir') {
          const collapsed = collapsedDirs.has(node.path);
          return (
            <View key={node.path}>
              <TouchableOpacity
                accessibilityRole="button"
                style={[styles.dirRow, { paddingLeft: depth * INDENT }]}
                onPress={() => onToggleDir(node.path)}
              >
                <Feather
                  name={collapsed ? 'chevron-right' : 'chevron-down'}
                  size={14}
                  color={theme.colors.textMuted}
                />
                <Feather name="folder" size={13} color={theme.colors.textMuted} />
                <Text
                  numberOfLines={1}
                  style={[styles.dirLabel, { color: theme.colors.textMuted }]}
                >
                  {node.name}
                </Text>
              </TouchableOpacity>
              {!collapsed && (
                <FileTree
                  nodes={node.children}
                  depth={depth + 1}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                  fileActions={fileActions}
                />
              )}
            </View>
          );
        }
        const { file } = node;
        return (
          <TouchableOpacity
            key={node.path}
            style={[styles.fileRow, { paddingLeft: depth * INDENT + 20 }]}
            onPress={() => onSelectFile(node.path)}
          >
            <Text numberOfLines={1} style={[styles.filePath, { color: theme.colors.text }]}>
              {node.name}
            </Text>
            {file.binary ? (
              <Text style={[styles.fileStat, { color: theme.colors.textMuted }]}>binary</Text>
            ) : (
              <Text style={styles.fileStat}>
                <Text style={{ color: theme.colors.success }}>+{file.insertions}</Text>{' '}
                <Text style={{ color: theme.colors.danger }}>-{file.deletions}</Text>
              </Text>
            )}
            {fileActions?.map((action) => (
              <TouchableOpacity
                key={action.label}
                accessibilityRole="button"
                accessibilityLabel={`${action.label} ${node.path}`}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                style={styles.actionButton}
                onPress={() => action.onPress(node.path)}
              >
                <Feather
                  name={action.icon}
                  size={15}
                  color={action.destructive ? theme.colors.danger : theme.colors.accent}
                />
              </TouchableOpacity>
            ))}
          </TouchableOpacity>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  dirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingRight: 8,
  },
  dirLabel: { fontFamily: 'monospace', fontSize: 13 },
  fileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingRight: 8,
  },
  filePath: { fontFamily: 'monospace', flex: 1, marginRight: 12 },
  fileStat: { fontFamily: 'monospace' },
  actionButton: { paddingHorizontal: 6 },
});
