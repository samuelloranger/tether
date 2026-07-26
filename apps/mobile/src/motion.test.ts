import { motionSpec } from './motion';

test('removes overlay delay when reduced motion is enabled', () => {
  expect(motionSpec('modalEnter', true)).toEqual({ duration: 0, useNativeDriver: true });
});

test('uses a quick native-driver exit for a dismissed drawer', () => {
  expect(motionSpec('drawerExit', false)).toEqual({ duration: 160, useNativeDriver: true });
});
