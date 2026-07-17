import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { confirmAction } from './dialog';
import type { DrawerSession } from './SessionDrawer';
import { PANEL_W, sessionActivity, type DesktopNavigationMode } from './desktopNavigation';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import type { Presentation } from './presentations';

export interface DesktopSessionNavigatorProps {
  mode: DesktopNavigationMode;
  sessions: DrawerSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  previews: Presentation[];
  activePreviewId: string | null;
  onSelectPreview: (id: string) => void;
  onClosePreview: (id: string) => void;
  onSettings: () => void;
}

const HIT = { top: 8, bottom: 8, left: 8, right: 8 };
const COMPACT_TEXT = { includeFontPadding: false } as const;

function confirmKill(id: string, onKill: (id: string) => void) {
  void confirmAction(
    'Kill this terminal?',
    "The process and its saved output will be deleted. This can't be undone.",
    { confirmLabel: 'Kill', destructive: true },
  ).then((ok) => {
    if (ok) onKill(id);
  });
}

function SessionPanel({ sessions, activeId, onSelect, onNew, onKill, previews, activePreviewId, onSelectPreview, onClosePreview, onSettings }: Omit<DesktopSessionNavigatorProps, 'mode'>) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <Feather name="terminal" size={14} color={theme.colors.accent} />
          <Text style={styles.title}>Workspace</Text>
        </View>
        <TouchableOpacity
          style={styles.settings}
          hitSlop={HIT}
          activeOpacity={0.6}
          onPress={onSettings}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Feather name="settings" size={15} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {sessions.map((session) => {
          const active = activePreviewId === null && session.id === activeId;
          const label = session.name || session.id;
          return (
            <View key={session.id} style={[styles.row, active && styles.rowActive]}>
              <TouchableOpacity
                style={styles.rowMain}
                activeOpacity={0.6}
                onPress={() => onSelect(session.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Terminal ${label}`}
              >
                <View style={[styles.dot, { backgroundColor: sessionActivity(session, active) === 'live' ? theme.colors.success : sessionActivity(session, active) === 'stopped' ? theme.colors.textFaint : theme.colors.border }]} />
                <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
                  {label}
                </Text>
                {session.status === 'stopped' && <Text style={styles.stopped}>stopped</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.kill}
                hitSlop={HIT}
                activeOpacity={0.6}
                onPress={() => confirmKill(session.id, onKill)}
                accessibilityRole="button"
                accessibilityLabel={`Kill terminal ${label}`}
              >
                <Feather name="x" size={16} color={theme.colors.danger} />
              </TouchableOpacity>
            </View>
          );
        })}
        {previews.map((preview) => {
          const active = preview.id === activePreviewId;
          return (
            <View key={`preview-${preview.id}`} style={[styles.row, active && styles.rowActive]}>
              <TouchableOpacity
                style={styles.rowMain}
                activeOpacity={0.6}
                onPress={() => onSelectPreview(preview.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Preview ${preview.title}`}
              >
                <Feather name="layout" size={14} color={theme.colors.accent} />
                <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
                  {preview.title}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.kill}
                hitSlop={HIT}
                activeOpacity={0.6}
                onPress={() => onClosePreview(preview.id)}
                accessibilityRole="button"
                accessibilityLabel={`Close preview ${preview.title}`}
              >
                <Feather name="x" size={16} color={theme.colors.danger} />
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>

      <TouchableOpacity
        style={styles.newButton}
        activeOpacity={0.8}
        onPress={onNew}
        accessibilityRole="button"
        accessibilityLabel="New terminal"
      >
        <Feather name="plus" size={16} color={theme.colors.accentText} />
        <Text style={styles.newButtonText}>New terminal</Text>
      </TouchableOpacity>
    </View>
  );
}

export function DesktopSessionNavigator({ mode, sessions, activeId, onSelect, onNew, onKill, previews, activePreviewId, onSelectPreview, onClosePreview, onSettings }: DesktopSessionNavigatorProps) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const [hoverOpen, setHoverOpen] = useState(false);
  const panelProps = { sessions, activeId, onSelect, onNew, onKill, previews, activePreviewId, onSelectPreview, onClosePreview, onSettings };
  // react-native-web forwards these DOM hover handlers, but Expo's View type omits them.
  const hoverHandlers = {
    onMouseEnter: () => setHoverOpen(true),
    onMouseLeave: () => setHoverOpen(false),
  } as any;

  if (mode === 'sidebar') {
    return <View style={styles.sidebar}><SessionPanel {...panelProps} /></View>;
  }

  if (mode === 'hover') {
    return (
      <View
        style={styles.hoverRegion}
        {...hoverHandlers}
      >
        <View style={styles.hoverTarget} />
        {hoverOpen && <View style={styles.hoverPanel}><SessionPanel {...panelProps} /></View>}
      </View>
    );
  }

  return (
    <ScrollView horizontal style={styles.tabs} contentContainerStyle={styles.tabsContent} showsHorizontalScrollIndicator={false}>
      {sessions.map((session) => {
        const active = activePreviewId === null && session.id === activeId;
        const label = session.name || session.id;
        return (
          <View key={session.id} style={[styles.tab, active && styles.tabActive]}>
            <TouchableOpacity
              style={styles.tabMain}
              activeOpacity={0.6}
              onPress={() => onSelect(session.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Terminal ${label}`}
            >
              <View style={[styles.dot, { backgroundColor: sessionActivity(session, active) === 'live' ? theme.colors.success : sessionActivity(session, active) === 'stopped' ? theme.colors.textFaint : theme.colors.border }]} />
              <Text style={styles.tabText} numberOfLines={1}>{label}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tabKill}
              hitSlop={HIT}
              activeOpacity={0.6}
              onPress={() => confirmKill(session.id, onKill)}
              accessibilityRole="button"
              accessibilityLabel={`Kill terminal ${label}`}
            >
              <Feather name="x" size={14} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
        );
      })}
      {previews.map((preview) => {
        const active = preview.id === activePreviewId;
        return (
          <View key={`preview-${preview.id}`} style={[styles.tab, active && styles.tabActive]}>
            <TouchableOpacity
              style={styles.tabMain}
              activeOpacity={0.6}
              onPress={() => onSelectPreview(preview.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Preview ${preview.title}`}
            >
              <Feather name="layout" size={13} color={theme.colors.accent} />
              <Text style={styles.tabText} numberOfLines={1}>{preview.title}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.tabKill}
              hitSlop={HIT}
              activeOpacity={0.6}
              onPress={() => onClosePreview(preview.id)}
              accessibilityRole="button"
              accessibilityLabel={`Close preview ${preview.title}`}
            >
              <Feather name="x" size={14} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
        );
      })}
    </ScrollView>
  );
}

const createStyles = (c: AppColors) => StyleSheet.create({
  sidebar: { width: PANEL_W, flexShrink: 0 },
  panel: { flex: 1, backgroundColor: c.surface, borderRightWidth: 1, borderRightColor: c.border },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { color: c.text, fontSize: 11, lineHeight: 13, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', ...COMPACT_TEXT },
  settings: { padding: 3 },
  list: { flex: 1, paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 6, borderRadius: 6 },
  rowActive: { backgroundColor: c.selected },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingLeft: 9 },
  dot: { width: 7, height: 7, borderRadius: 999 },
  name: { flex: 1, minWidth: 0, color: c.textMuted, fontSize: 13, lineHeight: 16, ...COMPACT_TEXT },
  nameActive: { color: c.text, fontWeight: '600' },
  stopped: { color: c.textFaint, fontSize: 10, lineHeight: 12, marginRight: 4, ...COMPACT_TEXT },
  kill: { padding: 7 },
  newButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, margin: 12, paddingVertical: 10, borderRadius: 7, backgroundColor: c.accent },
  newButtonText: { color: c.accentText, fontSize: 13, fontWeight: '700' },
  hoverRegion: { position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: 2 },
  hoverTarget: { width: 12, flex: 1 },
  hoverPanel: { position: 'absolute', top: 0, bottom: 0, left: 0, width: PANEL_W, shadowColor: c.overlay, shadowOpacity: 0.45, shadowRadius: 16, elevation: 12 },
  tabs: { flexGrow: 0, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
  tabsContent: { paddingHorizontal: 8 },
  tab: { flexDirection: 'row', alignItems: 'center', maxWidth: 220, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: c.accent, backgroundColor: c.selected },
  tabMain: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0, paddingLeft: 12, paddingVertical: 10 },
  tabText: { color: c.text, fontSize: 12, lineHeight: 15, fontWeight: '600', maxWidth: 150, ...COMPACT_TEXT },
  tabKill: { padding: 8 },
});
