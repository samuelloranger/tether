import Feather from '@expo/vector-icons/Feather';
import { useCallback, useMemo, useRef } from 'react';
import { Animated, PanResponder, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { HIT_SLOP, MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import type { HostHealthStatus } from './tether/hostHealth';
import type { HostProfile } from './tether/hostStore';
import { typeScale } from './type';

// Health in words, not a bare dot — "unreachable" needs to say that it is still
// retrying, or a dead host reads as a dead app.
const HEALTH_LABEL: Record<HostHealthStatus, string> = {
  unknown: 'Checking…',
  reachable: 'online',
  unreachable: 'Unreachable · retrying',
  unauthorized: 'Needs password',
};

function healthColor(
  status: HostHealthStatus,
  c: { success: string; danger: string; textFaint: string },
) {
  if (status === 'reachable') return c.success;
  if (status === 'unauthorized') return c.danger;
  return c.textFaint;
}

// The Hosts list is an index, not an editor: a row carries only what identifies
// a machine and whether it is up. Everything editable lives on the host page,
// so nothing here can be changed by a mis-tap.
export function HostsScreen({
  hosts,
  health,
  onBack,
  onAdd,
  onAppearance,
  onOpen,
  onReorder,
}: {
  hosts: HostProfile[];
  health?: Record<string, HostHealthStatus>;
  onBack: () => void;
  onAdd: () => void;
  onAppearance: () => void;
  onOpen: (hostId: string) => void;
  onReorder: (ids: string[]) => void;
}) {
  const { theme } = useAppTheme();
  const c = theme.colors;
  const move = (index: number, target: number) => {
    const next = [...hosts];
    if (target === index || !next[target]) return;
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    onReorder(next.map((host) => host.id));
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 24, maxWidth: 720, width: '100%', alignSelf: 'center' }}
      >
        <TouchableOpacity
          onPress={onBack}
          style={{ minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel="Close settings"
        >
          <Text style={[typeScale.body, { color: c.accent, marginBottom: 14 }]}>‹ Terminal</Text>
        </TouchableOpacity>
        <Text style={[typeScale.display, { color: c.text, marginBottom: 18 }]}>Settings</Text>

        <TouchableOpacity
          onPress={onAppearance}
          accessibilityRole="button"
          accessibilityLabel="Open appearance settings"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            backgroundColor: c.surface,
            borderColor: c.border,
            borderWidth: 1,
            borderRadius: SURFACE_RADIUS.control,
            paddingVertical: 12,
            paddingHorizontal: 14,
            marginBottom: 24,
            minHeight: MIN_TOUCH_TARGET,
          }}
        >
          <Feather name="sliders" size={18} color={c.accent} />
          <View style={{ flex: 1 }}>
            <Text style={[typeScale.body, { color: c.text, fontWeight: '600' }]}>Appearance</Text>
            <Text style={[typeScale.caption, { color: c.textFaint, marginTop: 2 }]}>
              Theme and terminal font
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={c.textFaint} />
        </TouchableOpacity>

        <Text style={[typeScale.eyebrow, { color: c.textMuted, marginBottom: 10 }]}>Hosts</Text>

        {hosts.map((host, index) => (
          <HostRow
            key={host.id}
            host={host}
            status={health?.[host.id] ?? 'unknown'}
            index={index}
            count={hosts.length}
            onOpen={() => onOpen(host.id)}
            onMove={(target) => move(index, target)}
          />
        ))}

        <TouchableOpacity
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="Add host"
          style={{ marginTop: 6, minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' }}
        >
          <Text style={[typeScale.body, { color: c.accent, fontWeight: '600' }]}>+ Add host</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const DRAG_ROW_HEIGHT = 72;

function HostRow({
  host,
  status,
  index,
  count,
  onOpen,
  onMove,
}: {
  host: HostProfile;
  status: HostHealthStatus;
  index: number;
  count: number;
  onOpen: () => void;
  onMove: (target: number) => void;
}) {
  const { theme } = useAppTheme();
  const c = theme.colors;
  const dragY = useRef(new Animated.Value(0)).current;
  const moveBy = useCallback(
    (delta: number) => onMove(Math.max(0, Math.min(count - 1, index + delta))),
    [count, index, onMove],
  );
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_event, gesture) => dragY.setValue(gesture.dy),
        onPanResponderRelease: (_event, gesture) => {
          moveBy(Math.round(gesture.dy / DRAG_ROW_HEIGHT));
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
        },
        onPanResponderTerminate: () =>
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start(),
      }),
    [dragY, moveBy],
  );
  return (
    <Animated.View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: c.surface,
        borderColor: c.border,
        borderWidth: 1,
        borderLeftWidth: 3,
        borderLeftColor: host.color,
        borderRadius: SURFACE_RADIUS.control,
        marginBottom: 8,
        minHeight: MIN_TOUCH_TARGET,
        transform: [{ translateY: dragY }],
        zIndex: 1,
      }}
    >
      <View
        {...panResponder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${host.name}`}
        accessibilityActions={[
          { name: 'decrement', label: `Move ${host.name} up` },
          { name: 'increment', label: `Move ${host.name} down` },
        ]}
        onAccessibilityAction={(event) =>
          moveBy(event.nativeEvent.actionName === 'decrement' ? -1 : 1)
        }
        hitSlop={HIT_SLOP}
        style={{
          width: MIN_TOUCH_TARGET,
          minHeight: MIN_TOUCH_TARGET,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name="menu" size={17} color={c.textMuted} />
      </View>
      <TouchableOpacity
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${host.name}, ${HEALTH_LABEL[status]}. Open host settings`}
        style={{
          flex: 1,
          minHeight: MIN_TOUCH_TARGET,
          paddingVertical: 12,
          paddingRight: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={[typeScale.body, { color: c.text, fontWeight: '600' }]}>{host.name}</Text>
          <Text style={[typeScale.caption, { color: c.textFaint, marginTop: 2 }]}>
            {host.host}:{host.port}
          </Text>
        </View>
        <Text style={[typeScale.caption, { color: healthColor(status, c) }]}>
          {HEALTH_LABEL[status]}
        </Text>
        <Feather name="chevron-right" size={18} color={c.textFaint} />
      </TouchableOpacity>
    </Animated.View>
  );
}
