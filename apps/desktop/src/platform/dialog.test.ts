import { expect, test } from 'bun:test';
import { type AlertRequest, confirmAction, notify, subscribeAlert } from './dialog';

function takeActive(box: { current: AlertRequest | null }): AlertRequest | null {
  return box.current;
}

test('notify resolves once the listener invokes resolve', async () => {
  const box: { current: AlertRequest | null } = { current: null };
  const unsub = subscribeAlert((req) => {
    box.current = req;
  });
  const pending = notify('Title', 'Body');
  const req = takeActive(box);
  expect(req?.kind).toBe('notify');
  if (req?.kind === 'notify') req.resolve();
  await pending;
  unsub();
});

test('second notify queues behind the first', async () => {
  const box: { current: AlertRequest | null } = { current: null };
  const unsub = subscribeAlert((req) => {
    box.current = req;
  });
  const first = notify('One', 'a');
  const second = notify('Two', 'b');
  const one = takeActive(box);
  expect(one?.kind).toBe('notify');
  if (one?.kind === 'notify') {
    expect(one.title).toBe('One');
    one.resolve();
  }
  await first;
  const two = takeActive(box);
  expect(two?.kind).toBe('notify');
  if (two?.kind === 'notify') {
    expect(two.title).toBe('Two');
    two.resolve();
  }
  await second;
  unsub();
});

test('confirmAction resolves true and false from each button', async () => {
  const box: { current: AlertRequest | null } = { current: null };
  const unsub = subscribeAlert((req) => {
    box.current = req;
  });
  const yes = confirmAction('Kill?', 'Sure?', { confirmLabel: 'Kill', destructive: true });
  const yesReq = takeActive(box);
  expect(yesReq?.kind).toBe('confirm');
  if (yesReq?.kind === 'confirm') yesReq.resolve(true);
  expect(await yes).toBe(true);
  const no = confirmAction('Kill?', 'Sure?');
  const noReq = takeActive(box);
  if (noReq?.kind === 'confirm') noReq.resolve(false);
  expect(await no).toBe(false);
  unsub();
});
