import { beforeEach, expect, mock, test } from 'bun:test';

const isPermissionGranted = mock(() => Promise.resolve(false));
const requestPermission = mock(() => Promise.resolve('granted' as const));
const sendNotification = mock((_opts: { title: string; body: string }) => {});
mock.module('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted,
  requestPermission,
  sendNotification,
}));

const invoke = mock((_cmd: string, _args?: unknown) => Promise.resolve());
mock.module('@tauri-apps/api/core', () => ({ invoke }));

const { ensureNotificationPermission, notify } = await import('./desktopNotify');

beforeEach(() => {
  isPermissionGranted.mockClear();
  requestPermission.mockClear();
  sendNotification.mockClear();
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve());
});

test('ensureNotificationPermission requests permission when not already granted', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(false));
  requestPermission.mockImplementation(() => Promise.resolve('granted'));
  await ensureNotificationPermission();
  expect(requestPermission).toHaveBeenCalled();
});

test('ensureNotificationPermission does not re-request when already granted', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(true));
  await ensureNotificationPermission();
  expect(requestPermission).not.toHaveBeenCalled();
});

test('notify routes through the send_os_notification Rust command', async () => {
  await notify('title', 'body');
  expect(invoke).toHaveBeenCalledWith('send_os_notification', { title: 'title', body: 'body' });
  expect(sendNotification).not.toHaveBeenCalled();
});

test('notify falls back to the JS plugin when the Rust command is unavailable', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('no command')));
  await notify('t', 'b');
  expect(sendNotification).toHaveBeenCalledWith({ title: 't', body: 'b' });
});

test('notify swallows a failing fallback without throwing', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('no command')));
  sendNotification.mockImplementationOnce(() => {
    throw new Error('D-Bus down');
  });
  await expect(notify('t', 'b')).resolves.toBeUndefined();
});
