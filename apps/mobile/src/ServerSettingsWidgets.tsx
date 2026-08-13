import { StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { typeScale } from './type';

export const HOST_COLORS = ['#89b4fa', '#a6e3a1', '#fab387', '#cba6f7', '#f38ba8'] as const;
export type ServerSettingsStyles = ReturnType<typeof createStyles>;

export function Section({
  title,
  children,
  subdued = false,
}: {
  title: string;
  children: React.ReactNode;
  subdued?: boolean;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text
        style={[
          typeScale.eyebrow,
          { color: subdued ? theme.colors.textMuted : theme.colors.accent },
        ]}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

export function Field({
  label,
  hint,
  secure,
  numeric,
  error,
  ...props
}: {
  label: string;
  hint?: string;
  value: string;
  editable?: boolean;
  secure?: boolean;
  numeric?: boolean;
  error?: string;
  onChangeText: (value: string) => void;
}) {
  const { theme } = useAppTheme();
  return (
    <View>
      <Text style={[typeScale.caption, { color: theme.colors.textMuted, marginBottom: 4 }]}>
        {label}
      </Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        secureTextEntry={secure}
        keyboardType={numeric ? 'numeric' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.colors.textFaint}
        style={{
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          padding: 10,
          color: theme.colors.text,
          backgroundColor: theme.colors.input,
        }}
      />
      {error ? (
        <Text style={[typeScale.label, { color: theme.colors.danger, marginTop: 4 }]}>{error}</Text>
      ) : hint ? (
        <Text style={[typeScale.caption, { color: theme.colors.textFaint, marginTop: 4 }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function ColorSwatches({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { theme } = useAppTheme();
  return (
    <View>
      <Text style={[typeScale.caption, { color: theme.colors.textMuted, marginBottom: 6 }]}>
        Colour
      </Text>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {HOST_COLORS.map((color, index) => (
          <TouchableOpacity
            key={color}
            onPress={() => onChange(color)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: value === color, disabled }}
            accessibilityLabel={`Host colour ${index + 1}`}
            style={{
              width: MIN_TOUCH_TARGET,
              height: MIN_TOUCH_TARGET,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: disabled ? 0.55 : 1,
            }}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: color,
                borderWidth: value === color ? 2 : 0,
                borderColor: theme.colors.text,
              }}
            />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export function Toggle({
  label,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ color: theme.colors.text }}>{label}</Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        accessibilityRole="switch"
        accessibilityLabel={label}
        trackColor={{ true: theme.colors.accent }}
      />
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  tone = 'default',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  const { theme } = useAppTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        {
          minHeight: MIN_TOUCH_TARGET,
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: SURFACE_RADIUS.control,
          paddingHorizontal: 12,
          backgroundColor: tone === 'danger' ? theme.colors.surfaceRaised : theme.colors.accent,
          opacity: disabled ? 0.55 : 1,
        },
        tone === 'danger' && { borderColor: theme.colors.danger, borderWidth: 1 },
      ]}
    >
      <Text
        style={[
          typeScale.label,
          { color: tone === 'danger' ? theme.colors.danger : theme.colors.accentText },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export function createStyles(c: AppColors, desktopUi: boolean) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: c.overlay,
      justifyContent: 'center',
      alignItems: 'center',
    },
    mobileBackdrop: { backgroundColor: c.background },
    // As a screen the panel owns the viewport, so it needs a real height for
    // the scrolling body to size against.
    // Desktop: a centered page at a readable measure. Mobile keeps the
    // full-bleed screen.
    inlinePanel: desktopUi
      ? {
          width: 720,
          maxWidth: '100%',
          flex: 1,
          minHeight: 0,
          maxHeight: '100%',
          borderRadius: 0,
        }
      : { width: '100%', flex: 1, maxHeight: '100%', borderRadius: 0 },
    inlineBackdrop: desktopUi
      ? { backgroundColor: c.background, justifyContent: 'flex-start', alignItems: 'center' }
      : {},
    panel: {
      width: desktopUi ? 580 : '100%',
      maxWidth: '100%',
      maxHeight: '100%',
      flex: desktopUi ? 0 : 1,
      backgroundColor: c.background,
      borderRadius: desktopUi ? SURFACE_RADIUS.panel : 0,
      overflow: 'hidden',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 18,
      borderBottomWidth: 1,
      borderLeftWidth: 2,
      borderColor: c.border,
    },
    title: { color: c.text, ...typeScale.title },
    subTitle: { color: c.textMuted, marginTop: 3, ...typeScale.label },
    action: { color: c.accent, ...typeScale.label },
    closeButton: {
      minWidth: MIN_TOUCH_TARGET,
      minHeight: MIN_TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
    },
    body: { padding: 18, gap: 24 },
    state: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
    hint: { color: c.textMuted, ...typeScale.label },
    message: { color: c.success, ...typeScale.body },
    error: { color: c.danger, ...typeScale.body },
    maintenance: { gap: 16 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    dialog: {
      width: 360,
      maxWidth: '90%',
      gap: 12,
      padding: 20,
      borderRadius: SURFACE_RADIUS.panel,
      backgroundColor: c.surface,
    },
    row: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  });
}
