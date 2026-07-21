import { beforeEach, expect, mock, test } from 'bun:test';

const isPermissionGranted = mock(() => Promise.resolve(false));
const requestPermission = mock(() => Promise.resolve('granted' as const));
const sendNotification = mock((_opts: { title: string; body: string }) => {});
mock.module('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted,
  requestPermission,
  sendNotification,
}));

const { ensureNotificationPermission, notify } = await import('./desktopNotify');

beforeEach(() => {
  isPermissionGranted.mockClear();
  requestPermission.mockClear();
  sendNotification.mockClear();
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

test('notify sends a notification once permission is granted', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(true));
  await ensureNotificationPermission();
  await notify('title', 'body');
  expect(sendNotification).toHaveBeenCalledWith({ title: 'title', body: 'body' });
});

test('notify no-ops when permission was denied', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(false));
  requestPermission.mockImplementation(() => Promise.resolve('denied'));
  await ensureNotificationPermission();
  await notify('title', 'body');
  expect(sendNotification).not.toHaveBeenCalled();
});
