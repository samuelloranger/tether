import type { TextStyle } from 'react-native';

type TextRole = 'display' | 'title' | 'body' | 'label' | 'caption' | 'eyebrow';

export const typeScale = {
  display: { fontSize: 22, fontWeight: '700', letterSpacing: 0, lineHeight: 28 },
  title: { fontSize: 18, fontWeight: '700', letterSpacing: 0, lineHeight: 24 },
  body: { fontSize: 14, fontWeight: '400', letterSpacing: 0, lineHeight: 20 },
  label: { fontSize: 12, fontWeight: '500', letterSpacing: 0, lineHeight: 16 },
  caption: { fontSize: 11, fontWeight: '400', letterSpacing: 0, lineHeight: 15 },
  eyebrow: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
    lineHeight: 18,
    textTransform: 'uppercase',
  },
} satisfies Record<TextRole, TextStyle>;
