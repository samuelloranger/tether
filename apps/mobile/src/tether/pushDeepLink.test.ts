import { describe, expect, test } from 'bun:test';
import { linkFromNotificationResponse } from './pushDeepLink';

const response = (data: Record<string, unknown> | null) => ({
  notification: { request: { content: { data } } },
});

describe('linkFromNotificationResponse', () => {
  test('extracts the session link a tap should follow', () => {
    expect(linkFromNotificationResponse(response({ link: 'tether://session/a?host=alpha' }))).toBe(
      'tether://session/a?host=alpha',
    );
  });

  test.each([
    ['no response at all', null],
    ['an undefined response', undefined],
    ['no data', response(null)],
    ['data without a link', response({ other: 'x' })],
    ['an empty link', response({ link: '' })],
    ['a non-string link', response({ link: 42 })],
  ])('returns null for %s', (_label, input) => {
    expect(linkFromNotificationResponse(input as never)).toBeNull();
  });

  test.each([
    ['https', 'https://evil.example/steal'],
    ['javascript', 'javascript:alert(1)'],
    ['a scheme-relative url', '//evil.example'],
    ['a lookalike scheme', 'tether-evil://session/a'],
  ])('refuses %s, since payloads are host-influenced', (_label, link) => {
    expect(linkFromNotificationResponse(response({ link }))).toBeNull();
  });
});
