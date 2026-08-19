import { StyleSheet } from 'react-native';
import type { AppColors } from './appTheme';
import {
  badgeStyles,
  chromeStyles,
  headerStyles,
  inputStyles,
  overlayStyles,
  shellStyles,
} from './stylesParts';

export { MONO } from './stylesParts';

export function createStyles(c: AppColors) {
  return StyleSheet.create({
    ...shellStyles(c),
    ...headerStyles(c),
    ...badgeStyles(c),
    ...overlayStyles(c),
    ...chromeStyles(c),
    ...inputStyles(c),
  });
}
