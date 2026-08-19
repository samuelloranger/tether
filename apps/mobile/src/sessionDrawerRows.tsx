import Feather from '@expo/vector-icons/Feather';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { activityDotKey, terminalAccessibilityLabel } from './activity';
import type { AppColors } from './appTheme';
import { isRecentlyActive } from './desktopNavigation';
import { confirmAction } from './dialog';
import { HIT_SLOP } from './interaction';
import type { Presentation } from './presentations';
import type { DrawerSession } from './SessionDrawer';
import type { DrawerStyles } from './sessionDrawerStyles';
import { sessionLabel } from './sessionLabel';
import type { HostHealthStatus } from './tether/hostHealth';
import type { HostProfile } from './tether/hostStore';

export function confirmKill(id: string, onKill: (id: string) => void) {
  void confirmAction(
    'Kill this terminal?',
    "The process and its saved output will be deleted. This can't be undone.",
    { confirmLabel: 'Kill', destructive: true },
  ).then((ok) => {
    if (ok) onKill(id);
  });
}

function HostHeader({
  host,
  health,
  styles,
  textMuted,
  onRetryHost,
  onReenterPassword,
  onHostSettings,
}: {
  host: HostProfile;
  health: HostHealthStatus;
  styles: DrawerStyles;
  textMuted: string;
  onRetryHost: (hostId: string) => void;
  onReenterPassword: (hostId: string) => void;
  onHostSettings?: (hostId: string) => void;
}) {
  return (
    <View style={styles.hostHeader}>
      <Text style={styles.hostName}>{host.name}</Text>
      {health === 'unknown' && <Text style={styles.hostStatus}>connecting…</Text>}
      {health === 'reachable' && (
        <Text style={[styles.hostStatus, styles.hostReachable]}>online</Text>
      )}
      {health === 'unreachable' && (
        <TouchableOpacity
          onPress={() => onRetryHost(host.id)}
          accessibilityRole="button"
          accessibilityLabel={`Retry ${host.name}`}
        >
          <Text style={styles.hostAction}>Retry</Text>
        </TouchableOpacity>
      )}
      {health === 'unauthorized' && (
        <TouchableOpacity
          onPress={() => onReenterPassword(host.id)}
          accessibilityRole="button"
          accessibilityLabel={`Re-enter password for ${host.name}`}
        >
          <Text style={styles.hostAction}>Re-enter password</Text>
        </TouchableOpacity>
      )}
      {onHostSettings && (
        <TouchableOpacity
          onPress={() => onHostSettings(host.id)}
          accessibilityRole="button"
          accessibilityLabel={`Server settings for ${host.name}`}
        >
          <Feather name="settings" size={14} color={textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function SessionRow({
  host,
  session: s,
  styles,
  warning,
  danger,
  active,
  onSelect,
  onKill,
}: {
  host: HostProfile;
  session: DrawerSession;
  styles: DrawerStyles;
  warning: string;
  danger: string;
  active: boolean;
  onSelect: (hostId: string, id: string) => void;
  onKill: (id: string) => void;
}) {
  const live = active || isRecentlyActive(s.last_output_at);
  const dotKey = activityDotKey(s.status, s.activity, live);
  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <TouchableOpacity
        style={styles.rowMain}
        activeOpacity={0.6}
        onPress={() => onSelect(s.hostId, s.id)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={terminalAccessibilityLabel(
          `${sessionLabel(s)} on ${host.name}`,
          s.status,
          s.activity,
          live,
        )}
      >
        <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
          {sessionLabel(s)}
        </Text>
        {s.status === 'stopped' && <Text style={styles.stopped}>stopped</Text>}
        {dotKey === 'waiting' && <Text style={[styles.stopped, { color: warning }]}>waiting</Text>}
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.kill}
        hitSlop={HIT_SLOP}
        activeOpacity={0.6}
        onPress={() => onKill(s.id)}
        accessibilityRole="button"
        accessibilityLabel={`Kill terminal ${s.id}`}
      >
        <Feather name="x" size={16} color={danger} />
      </TouchableOpacity>
    </View>
  );
}

function PreviewRow({
  preview,
  styles,
  accent,
  danger,
  active,
  onSelectPreview,
  onClosePreview,
}: {
  preview: Presentation;
  styles: DrawerStyles;
  accent: string;
  danger: string;
  active: boolean;
  onSelectPreview: (id: string) => void;
  onClosePreview: (id: string) => void;
}) {
  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <TouchableOpacity
        style={styles.rowMain}
        activeOpacity={0.6}
        onPress={() => onSelectPreview(preview.id)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`Preview ${preview.title}`}
      >
        <Feather name="layout" size={14} color={accent} style={styles.previewIcon} />
        <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
          {preview.title}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.kill}
        hitSlop={HIT_SLOP}
        activeOpacity={0.6}
        onPress={() => onClosePreview(preview.id)}
        accessibilityRole="button"
        accessibilityLabel={`Close preview ${preview.title}`}
      >
        <Feather name="x" size={16} color={danger} />
      </TouchableOpacity>
    </View>
  );
}

type DrawerPanelBodyProps = {
  styles: DrawerStyles;
  colors: AppColors;
  hosts: HostProfile[];
  healthByHost: Record<string, HostHealthStatus>;
  sessions: DrawerSession[];
  activeHostId: string;
  activeId: string;
  activePreviewId: string | null;
  previews: Presentation[];
  showPin: boolean;
  docked: boolean;
  onTogglePin?: () => void;
  onSelect: (hostId: string, id: string) => void;
  onKillSession: (id: string) => void;
  onRetryHost: (hostId: string) => void;
  onReenterPassword: (hostId: string) => void;
  onHostSettings?: (hostId: string) => void;
  onSelectPreview: (id: string) => void;
  onClosePreview: (id: string) => void;
  onNew: () => void;
};

function HostSection({ host, p }: { host: HostProfile; p: DrawerPanelBodyProps }) {
  const health = p.healthByHost[host.id] ?? 'unknown';
  const unavailable = health === 'unreachable' || health === 'unauthorized';
  const hostSessions = unavailable
    ? []
    : p.sessions.filter((session) => session.hostId === host.id);
  return (
    <View
      style={[
        p.styles.hostSection,
        { borderLeftColor: host.color },
        unavailable && p.styles.hostSectionUnavailable,
      ]}
      accessibilityLabel={`${host.name} host section`}
    >
      <HostHeader
        host={host}
        health={health}
        styles={p.styles}
        textMuted={p.colors.textMuted}
        onRetryHost={p.onRetryHost}
        onReenterPassword={p.onReenterPassword}
        onHostSettings={p.onHostSettings}
      />
      {hostSessions.map((s) => (
        <SessionRow
          key={`${s.hostId}:${s.id}`}
          host={host}
          session={s}
          styles={p.styles}
          warning={p.colors.warning}
          danger={p.colors.danger}
          active={p.activePreviewId === null && s.hostId === p.activeHostId && s.id === p.activeId}
          onSelect={p.onSelect}
          onKill={p.onKillSession}
        />
      ))}
    </View>
  );
}

export function DrawerPanelBody(p: DrawerPanelBodyProps) {
  return (
    <>
      {p.showPin && p.onTogglePin ? (
        <View style={p.styles.pinRow}>
          <TouchableOpacity
            onPress={p.onTogglePin}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={p.docked ? 'Unpin sidebar' : 'Pin sidebar'}
            style={p.styles.pinBtn}
          >
            <Feather name="sidebar" size={16} color={p.colors.textMuted} />
            <Text style={p.styles.pinLabel}>{p.docked ? 'Unpin' : 'Pin'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <ScrollView style={p.styles.list} keyboardShouldPersistTaps="handled">
        {p.hosts.map((host) => (
          <HostSection key={host.id} host={host} p={p} />
        ))}
        {p.previews.map((preview) => (
          <PreviewRow
            key={`preview-${preview.id}`}
            preview={preview}
            styles={p.styles}
            accent={p.colors.accent}
            danger={p.colors.danger}
            active={preview.id === p.activePreviewId}
            onSelectPreview={p.onSelectPreview}
            onClosePreview={p.onClosePreview}
          />
        ))}
      </ScrollView>
      <TouchableOpacity
        style={p.styles.newBtn}
        activeOpacity={0.8}
        onPress={p.onNew}
        accessibilityRole="button"
        accessibilityLabel="New terminal"
      >
        <Feather name="plus" size={16} color={p.colors.text} />
        <Text style={p.styles.newBtnText}>New terminal</Text>
      </TouchableOpacity>
    </>
  );
}
