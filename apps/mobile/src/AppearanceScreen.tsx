import Feather from '@expo/vector-icons/Feather';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { THEME_OPTIONS } from './appTheme';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { APPEARANCE_FONTS, THEME_LABELS } from './SessionModals';
import { typeScale } from './type';

export function AppearanceScreen({
  fontFamily,
  onFontChange,
  onBack,
}: {
  fontFamily: string;
  onFontChange: (fontFamily: string) => void;
  onBack: () => void;
}) {
  const { preference, setPreference, theme } = useAppTheme();
  const c = theme.colors;
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 24, maxWidth: 720, width: '100%', alignSelf: 'center' }}
      >
        <TouchableOpacity
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to settings"
          style={{ minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' }}
        >
          <Text style={[typeScale.body, { color: c.accent, marginBottom: 14 }]}>‹ Settings</Text>
        </TouchableOpacity>
        <Text style={[typeScale.display, { color: c.text, marginBottom: 20 }]}>Appearance</Text>

        <Text style={[typeScale.eyebrow, { color: c.textMuted, marginBottom: 8 }]}>Theme</Text>
        {THEME_OPTIONS.map((id) => (
          <Option
            key={id}
            label={THEME_LABELS[id]}
            selected={id === preference}
            onPress={() => setPreference(id)}
          />
        ))}

        <Text style={[typeScale.eyebrow, { color: c.textMuted, marginTop: 24, marginBottom: 8 }]}>
          Terminal font
        </Text>
        {APPEARANCE_FONTS.map((font) => (
          <Option
            key={font}
            label={font.split('_')[0]}
            fontFamily={font}
            selected={font === fontFamily}
            onPress={() => onFontChange(font)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function Option({
  label,
  selected,
  fontFamily,
  onPress,
}: {
  label: string;
  selected: boolean;
  fontFamily?: string;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  const c = theme.colors;
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      style={{
        minHeight: MIN_TOUCH_TARGET,
        borderRadius: SURFACE_RADIUS.control,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: selected ? c.surfaceRaised : c.surface,
        borderColor: selected ? c.accent : c.border,
        borderWidth: 1,
        marginBottom: 8,
      }}
    >
      <Text style={[typeScale.body, { color: c.text, fontFamily }]}>{label}</Text>
      {selected && <Feather name="check" size={17} color={c.accent} />}
    </TouchableOpacity>
  );
}
