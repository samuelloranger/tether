import { expect, mock, test } from 'bun:test';

// The real 'react-native' package uses Flow syntax Bun's parser can't handle
// (`import typeof * as X from './index.js.flow'`) — no existing test in this
// repo imports it for real, they all mock around it. Mock it directly here,
// with Platform.OS set to 'web' so dialog.ts's isDesktop branch is exercised.
mock.module('react-native', () => ({
  Platform: { OS: 'web' },
  Alert: { alert: () => {} },
}));

const { notify, confirmAction, subscribeAlert } = await import('./dialog');

// subscribeAlert calls its listener immediately on subscribe with the current
// queue state (null when nothing is pending) — so `seen` always has one extra
// leading entry before any notify()/confirmAction() of this test's own is
// announced. Always read the *last* entry, never assume seen[0]/seen.length.

test('notify resolves once the rendered alert calls resolve()', async () => {
  const seen: unknown[] = [];
  const unsub = subscribeAlert((req) => seen.push(req));

  const pending = notify('Title', 'Body', 'error');
  await Promise.resolve(); // let notify's Promise executor run and push

  const req = seen[seen.length - 1] as Extract<import('./dialog').AlertRequest, { kind: 'notify' }>;
  expect(req.kind).toBe('notify');
  expect(req.title).toBe('Title');
  expect(req.body).toBe('Body');
  expect(req.level).toBe('error');

  req.resolve();
  await expect(pending).resolves.toBeUndefined();
  unsub();
});

test('a second notify() while one is pending queues instead of replacing it', async () => {
  const seen: unknown[] = [];
  const unsub = subscribeAlert((req) => seen.push(req));

  const first = notify('First', 'Body');
  await Promise.resolve();
  const second = notify('Second', 'Body');
  await Promise.resolve();

  // Still showing the first one — the second hasn't been announced to the listener yet.
  const firstReq = seen[seen.length - 1] as Extract<
    import('./dialog').AlertRequest,
    { kind: 'notify' }
  >;
  expect(firstReq.title).toBe('First');

  firstReq.resolve();
  await expect(first).resolves.toBeUndefined();

  const secondReq = seen[seen.length - 1] as Extract<
    import('./dialog').AlertRequest,
    { kind: 'notify' }
  >;
  expect(secondReq.title).toBe('Second');
  secondReq.resolve();
  await expect(second).resolves.toBeUndefined();
  unsub();
});

test('confirmAction resolves true when the confirm button fires', async () => {
  const seen: unknown[] = [];
  const unsub = subscribeAlert((req) => seen.push(req));

  const pending = confirmAction('Kill session?', 'This cannot be undone.', {
    confirmLabel: 'Kill',
    destructive: true,
  });
  await Promise.resolve();

  const req = seen[seen.length - 1] as Extract<
    import('./dialog').AlertRequest,
    { kind: 'confirm' }
  >;
  expect(req.kind).toBe('confirm');
  expect(req.confirmLabel).toBe('Kill');
  expect(req.destructive).toBe(true);

  req.resolve(true);
  await expect(pending).resolves.toBe(true);
  unsub();
});

test('confirmAction resolves false when cancel fires', async () => {
  const seen: unknown[] = [];
  const unsub = subscribeAlert((req) => seen.push(req));

  const pending = confirmAction('Kill session?', 'This cannot be undone.');
  await Promise.resolve();

  const req = seen[seen.length - 1] as Extract<
    import('./dialog').AlertRequest,
    { kind: 'confirm' }
  >;
  req.resolve(false);
  await expect(pending).resolves.toBe(false);
  unsub();
});
