import { availableOverlayHeight } from './overlayLayout';

test('reserves top offset and bottom breathing room for an overlay menu', () => {
  expect(availableOverlayHeight(640, 76, 12)).toBe(552);
});

test('does not return a negative height on an extremely short viewport', () => {
  expect(availableOverlayHeight(60, 76, 12)).toBe(0);
});
