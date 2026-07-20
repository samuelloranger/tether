import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useAppTheme } from './AppThemeProvider';
import type { FileTreeNode } from './diffModel';

const INDENT = 16;

// Renders a real nested folder tree (like a file explorer) — folders indent
// their contents one level deeper instead of listing full path prefixes.
export function FileTree({
  nodes,
  depth = 0,
  collapsedDirs,
  onToggleDir,
  onSelectFile,
}: {
  nodes: FileTreeNode[];
  depth?: number;
  collapsedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
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
                <Text numberOfLines={1} style={[styles.dirLabel, { color: theme.colors.textMuted }]}>
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
          </TouchableOpacity>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  dirRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingRight: 8 },
  dirLabel: { fontFamily: 'monospace', fontSize: 13 },
  fileRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingRight: 8 },
  filePath: { fontFamily: 'monospace', flex: 1, marginRight: 12 },
  fileStat: { fontFamily: 'monospace' },
});
