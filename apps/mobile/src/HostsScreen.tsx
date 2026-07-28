import Feather from '@expo/vector-icons/Feather';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { HIT_SLOP, MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import type { HostHealthStatus } from './tether/hostHealth';
import type { HostProfile } from './tether/hostStore';
import { typeScale } from './type';

// Health in words, not a bare dot — "unreachable" needs to say that it is still
// retrying, or a dead host reads as a dead app.
const HEALTH_LABEL: Record<HostHealthStatus, string> = {
  unknown: 'Checking…',
  reachable: 'Connected',
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
  onOpen,
  onReorder,
}: {
  hosts: HostProfile[];
  health?: Record<string, HostHealthStatus>;
  onBack: () => void;
  onAdd: () => void;
  onOpen: (hostId: string) => void;
  onReorder: (ids: string[]) => void;
}) {
  const { theme } = useAppTheme();
  const c = theme.colors;
  const move = (index: number, delta: -1 | 1) => {
    const next = [...hosts];
    const target = index + delta;
    if (!next[target]) return;
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next.map((host) => host.id));
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: 24, maxWidth: 720, width: '100%' }}>
        <TouchableOpacity
          onPress={onBack}
          style={{ minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel="Back to settings"
        >
          <Text style={[typeScale.body, { color: c.accent, marginBottom: 14 }]}>‹ Settings</Text>
        </TouchableOpacity>
        <Text style={[typeScale.display, { color: c.text, marginBottom: 14 }]}>Hosts</Text>

        {hosts.map((host, index) => {
          const status = health?.[host.id] ?? 'unknown';
          return (
            <TouchableOpacity
              key={host.id}
              onPress={() => onOpen(host.id)}
              accessibilityRole="button"
              accessibilityLabel={`${host.name}, ${HEALTH_LABEL[status]}. Open host settings`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                backgroundColor: c.surface,
                borderColor: c.border,
                borderWidth: 1,
                borderLeftWidth: 3,
                borderLeftColor: host.color,
                borderRadius: SURFACE_RADIUS.control,
                paddingVertical: 12,
                paddingHorizontal: 14,
                marginBottom: 8,
                minHeight: MIN_TOUCH_TARGET,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={[typeScale.body, { color: c.text, fontWeight: '600' }]}>
                  {host.name}
                </Text>
                <Text style={[typeScale.caption, { color: c.textFaint, marginTop: 2 }]}>
                  {host.host}:{host.port}
                </Text>
              </View>
              <Text style={[typeScale.caption, { color: healthColor(status, c) }]}>
                {HEALTH_LABEL[status]}
              </Text>
              {/* Reorder sits next to the row it moves, not at the far edge. */}
              <View style={{ flexDirection: 'row' }}>
                <TouchableOpacity
                  onPress={() => move(index, -1)}
                  disabled={index === 0}
                  hitSlop={HIT_SLOP}
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${host.name} up`}
                  style={{ padding: 6, opacity: index === 0 ? 0.3 : 1 }}
                >
                  <Feather name="chevron-up" size={16} color={c.textMuted} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => move(index, 1)}
                  disabled={index === hosts.length - 1}
                  hitSlop={HIT_SLOP}
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${host.name} down`}
                  style={{ padding: 6, opacity: index === hosts.length - 1 ? 0.3 : 1 }}
                >
                  <Feather name="chevron-down" size={16} color={c.textMuted} />
                </TouchableOpacity>
              </View>
              <Feather name="chevron-right" size={18} color={c.textFaint} />
            </TouchableOpacity>
          );
        })}

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
