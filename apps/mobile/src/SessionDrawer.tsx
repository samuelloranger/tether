import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Pressable } from 'react-native';

export interface DrawerSession {
  id: string;
  status: 'running' | 'stopped';
  last_output_at: string | null;
}

interface SessionDrawerProps {
  visible: boolean;
  sessions: DrawerSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onClose: () => void;
}

function isRecentlyActive(ts: string | null): boolean {
  if (!ts) return false;
  // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"; treat as UTC.
  const t = Date.parse(ts.replace(' ', 'T') + 'Z');
  return !Number.isNaN(t) && Date.now() - t < 10_000;
}

export function SessionDrawer({
  visible,
  sessions,
  activeId,
  onSelect,
  onNew,
  onKill,
  onClose,
}: SessionDrawerProps) {
  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.panel}>
        <Text style={styles.title}>Terminals</Text>
        <ScrollView style={styles.list}>
          {sessions.map((s) => {
            const active = s.id === activeId;
            const live = active || isRecentlyActive(s.last_output_at);
            return (
              <View key={s.id} style={[styles.row, active && styles.rowActive]}>
                <TouchableOpacity style={styles.rowMain} onPress={() => onSelect(s.id)}>
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: s.status === 'stopped' ? '#64748b' : live ? '#34d399' : '#334155' },
                    ]}
                  />
                  <Text style={[styles.name, active && styles.nameActive]}>{s.id}</Text>
                  {s.status === 'stopped' && <Text style={styles.stopped}>stopped</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.kill} onPress={() => onKill(s.id)}>
                  <Text style={styles.killText}>✕</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
        <TouchableOpacity style={styles.newBtn} onPress={onNew}>
          <Text style={styles.newBtnText}>+ New terminal</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, flexDirection: 'row', zIndex: 100 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  panel: {
    width: 260,
    backgroundColor: '#0b0f19',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.1)',
    paddingTop: 56,
    paddingHorizontal: 12,
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  title: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    marginBottom: 4,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  rowActive: { backgroundColor: 'rgba(99,102,241,0.15)' },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  name: { color: '#cbd5e1', fontFamily: 'Courier', fontSize: 13 },
  nameActive: { color: '#818cf8', fontWeight: '700' },
  stopped: { color: '#64748b', fontSize: 10, marginLeft: 8 },
  kill: { padding: 10 },
  killText: { color: '#f87171', fontSize: 14 },
  newBtn: {
    marginVertical: 12,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#4f46e5',
    alignItems: 'center',
  },
  newBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
