import Feather from '@expo/vector-icons/Feather';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { HostProfile } from './tether/hostStore';

const COLORS = ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7'];

export function HostsScreen({
  hosts,
  onBack,
  onAdd,
  onEdit,
  onRemove,
  onUpdate,
  onReorder,
}: {
  hosts: HostProfile[];
  onBack: () => void;
  onAdd: () => void;
  onEdit: (hostId: string) => void;
  onRemove: (hostId: string) => void;
  onUpdate: (hostId: string, changes: Partial<Omit<HostProfile, 'id' | 'order'>>) => void;
  onReorder: (ids: string[]) => void;
}) {
  const { theme } = useAppTheme();
  const move = (index: number, delta: -1 | 1) => {
    const next = [...hosts];
    const target = index + delta;
    if (!next[target]) return;
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next.map((host) => host.id));
  };
  return (
    <View style={{ flex: 1, padding: 24, backgroundColor: theme.colors.background }}>
      <TouchableOpacity
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to connection settings"
      >
        <Text style={{ color: theme.colors.accent, marginBottom: 18 }}>‹ Connection settings</Text>
      </TouchableOpacity>
      <Text style={{ color: theme.colors.text, fontSize: 22, fontWeight: '700', marginBottom: 12 }}>
        Hosts
      </Text>
      {hosts.map((host, index) => (
        <View
          key={host.id}
          style={{
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            borderWidth: 1,
            borderRadius: 10,
            padding: 12,
            marginBottom: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: host.color }} />
            <TextInput
              value={host.name}
              onChangeText={(name) => onUpdate(host.id, { name })}
              onEndEditing={(event) =>
                onUpdate(host.id, { name: event.nativeEvent.text.trim() || host.name })
              }
              style={{ flex: 1, color: theme.colors.text, fontWeight: '700' }}
              accessibilityLabel={`Host name ${host.name}`}
            />
            <TouchableOpacity
              onPress={() => move(index, -1)}
              disabled={index === 0}
              accessibilityRole="button"
              accessibilityLabel={`Move ${host.name} up`}
            >
              <Feather name="chevron-up" size={18} color={theme.colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => move(index, 1)}
              disabled={index === hosts.length - 1}
              accessibilityRole="button"
              accessibilityLabel={`Move ${host.name} down`}
            >
              <Feather name="chevron-down" size={18} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={{ color: theme.colors.textMuted, fontSize: 12, marginTop: 5 }}>
            {host.host}:{host.port}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
            {COLORS.map((color) => (
              <TouchableOpacity
                key={color}
                onPress={() => onUpdate(host.id, { color })}
                accessibilityRole="button"
                accessibilityLabel={`Set ${host.name} color`}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: color,
                  borderWidth: host.color === color ? 2 : 0,
                  borderColor: theme.colors.text,
                }}
              />
            ))}
            <TouchableOpacity
              onPress={() => onEdit(host.id)}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${host.name}`}
            >
              <Text style={{ color: theme.colors.accent }}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onRemove(host.id)}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${host.name}`}
            >
              <Text style={{ color: theme.colors.danger }}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
      <TouchableOpacity
        onPress={onAdd}
        accessibilityRole="button"
        accessibilityLabel="Add host"
        style={{ marginTop: 8 }}
      >
        <Text style={{ color: theme.colors.accent, fontWeight: '700' }}>+ Add host</Text>
      </TouchableOpacity>
    </View>
  );
}
