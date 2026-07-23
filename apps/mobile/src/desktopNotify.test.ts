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

test('notify still attempts to send even when the permission verdict is not granted', async () => {
  // Linux (libnotify/D-Bus) has no real permission model, so a stale/false
  // verdict must not silently swallow every notification. Best-effort: send
  // anyway rather than hard-gate on `granted`.
  isPermissionGranted.mockImplementation(() => Promise.resolve(false));
  requestPermission.mockImplementation(() => Promise.resolve('denied'));
  await ensureNotificationPermission();
  await notify('title', 'body');
  expect(sendNotification).toHaveBeenCalledWith({ title: 'title', body: 'body' });
});

test('notify sends even when requestPermission never resolves (hung Linux portal)', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(false));
  requestPermission.mockImplementation(() => new Promise(() => {})); // never resolves
  await notify('title', 'body');
  expect(sendNotification).toHaveBeenCalledWith({ title: 'title', body: 'body' });
});

test('notify swallows a missing/failing plugin without throwing', async () => {
  isPermissionGranted.mockImplementation(() => Promise.resolve(true));
  await ensureNotificationPermission();
  sendNotification.mockImplementationOnce(() => {
    throw new Error('D-Bus unavailable');
  });
  await expect(notify('t', 'b')).resolves.toBeUndefined();
});
