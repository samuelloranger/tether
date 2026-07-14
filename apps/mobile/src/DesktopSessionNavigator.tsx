import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { confirmAction } from './dialog';
import type { DrawerSession } from './SessionDrawer';
import { PANEL_W, sessionDotColor, type DesktopNavigationMode } from './desktopNavigation';

export interface DesktopSessionNavigatorProps {
  mode: DesktopNavigationMode;
  sessions: DrawerSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onSettings: () => void;
}

const HIT = { top: 8, bottom: 8, left: 8, right: 8 };

function confirmKill(id: string, onKill: (id: string) => void) {
  void confirmAction(
    'Kill this terminal?',
    "The process and its saved output will be deleted. This can't be undone.",
    { confirmLabel: 'Kill', destructive: true },
  ).then((ok) => {
    if (ok) onKill(id);
  });
}

function SessionPanel({ sessions, activeId, onSelect, onNew, onKill, onSettings }: Omit<DesktopSessionNavigatorProps, 'mode'>) {
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <Feather name="terminal" size={14} color="#818cf8" />
          <Text style={styles.title}>Terminals</Text>
        </View>
        <TouchableOpacity
          style={styles.settings}
          hitSlop={HIT}
          activeOpacity={0.6}
          onPress={onSettings}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Feather name="settings" size={15} color="#94a3b8" />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {sessions.map((session) => {
          const active = session.id === activeId;
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
                <View style={[styles.dot, { backgroundColor: sessionDotColor(session, active) }]} />
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
                <Feather name="x" size={16} color="#f87171" />
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
        <Feather name="plus" size={16} color="#fff" />
        <Text style={styles.newButtonText}>New terminal</Text>
      </TouchableOpacity>
    </View>
  );
}

export function DesktopSessionNavigator({ mode, sessions, activeId, onSelect, onNew, onKill, onSettings }: DesktopSessionNavigatorProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const panelProps = { sessions, activeId, onSelect, onNew, onKill, onSettings };
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
        const active = session.id === activeId;
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
              <View style={[styles.dot, { backgroundColor: sessionDotColor(session, active) }]} />
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
              <Feather name="x" size={14} color="#94a3b8" />
            </TouchableOpacity>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sidebar: { width: PANEL_W, flexShrink: 0 },
  panel: { flex: 1, backgroundColor: '#0b0f19', borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.08)' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.07)' },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { color: '#cbd5e1', fontSize: 11, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase' },
  settings: { padding: 3 },
  list: { flex: 1, paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 6, borderRadius: 6 },
  rowActive: { backgroundColor: 'rgba(99,102,241,0.16)' },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingLeft: 9 },
  dot: { width: 7, height: 7, borderRadius: 999 },
  name: { flex: 1, minWidth: 0, color: '#94a3b8', fontSize: 13 },
  nameActive: { color: '#e2e8f0', fontWeight: '600' },
  stopped: { color: '#64748b', fontSize: 10, marginRight: 4 },
  kill: { padding: 7 },
  newButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, margin: 12, paddingVertical: 10, borderRadius: 7, backgroundColor: '#4f46e5' },
  newButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  hoverRegion: { position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: 2 },
  hoverTarget: { width: 12, flex: 1 },
  hoverPanel: { position: 'absolute', top: 0, bottom: 0, left: 0, width: PANEL_W, shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 16, elevation: 12 },
  tabs: { flexGrow: 0, backgroundColor: '#0b0f19', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  tabsContent: { paddingHorizontal: 8 },
  tab: { flexDirection: 'row', alignItems: 'center', maxWidth: 220, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#818cf8', backgroundColor: 'rgba(99,102,241,0.1)' },
  tabMain: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0, paddingLeft: 12, paddingVertical: 10 },
  tabText: { color: '#cbd5e1', fontSize: 12, fontWeight: '600', maxWidth: 150 },
  tabKill: { padding: 8 },
});
