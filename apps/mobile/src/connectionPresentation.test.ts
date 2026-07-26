import { connectionPresentation } from './connectionPresentation';

test('describes an authentication failure without suggesting a reconnect is active', () => {
  expect(connectionPresentation('auth-failed', false)).toEqual({
    label: 'Wrong password.',
    tone: 'danger',
  });
});

test('reassures a previously connected session while it reconnects', () => {
  expect(connectionPresentation('disconnected', true)).toEqual({
    label: 'Reconnecting… (session kept running on the server)',
    tone: 'warning',
  });
});
