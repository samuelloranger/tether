import { StyleSheet } from 'react-native';
import { minTouchTarget } from './interaction';

const TOUCH_TARGET = minTouchTarget();

export const gitDrawerStyles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  iconButton: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, flexDirection: 'row' },
  left: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'column',
    overflow: 'visible',
    zIndex: 3,
  },
  leftFallback: { flex: 1 },
  splitterHit: {
    width: 8,
    marginLeft: -3,
    marginRight: -3,
    zIndex: 2,
    alignItems: 'center',
  },
  splitterLine: {
    width: StyleSheet.hairlineWidth,
    flex: 1,
  },
  right: { flex: 1, minWidth: 0 },
  listContent: { padding: 12, alignItems: 'stretch' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
});
