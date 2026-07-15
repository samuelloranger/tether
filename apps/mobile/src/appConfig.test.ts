import { expect, test } from 'bun:test';
import appConfig from '../app.json';

test('allows System appearance on native platforms', () => {
  expect(appConfig.expo.userInterfaceStyle).toBe('automatic');
});
