/**
 * Dialect negotiation on the holder socket.
 *
 * The scenario that matters: `tether update` replaces the server while holders —
 * detached processes running the *old* code — keep a user's shells alive.
 * `reattachHolders()` adopts them, so the new server has to speak the old
 * newline-JSON dialect to those and the new binary framing to holders it spawns
 * itself. These tests stand up a fake holder of each kind on a real unix socket.
 */

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deleteSession, upsertSession } from './db';
import {
  decodeHolderFrame,
  decodeLegacyHolderLine,
  encodeHolderCwd,
  encodeHolderExit,
  encodeHolderHello,
  encodeHolderOutput,
  type HolderMessage,
  takeLegacyLines,
} from './holderFrame';
import { FrameDecoder } from './proto/frame';
import { attach, instances, sendHolderInput, sendHolderResize } from './ptyHolder';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function waitFor(condition: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

type FakeHolder = {
  sockPath: string;
  /** Everything the server has sent us, decoded in the dialect we speak. */
  received: HolderMessage[];
  send: (bytes: Uint8Array | string) => void;
};

/** A fake holder on a real unix socket, reading in the given dialect. */
function fakeHolder(id: string, dialect: 'binary' | 'legacy', greet: boolean): FakeHolder {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-holder-negotiate-'));
  const sockPath = path.join(dir, `${id}.sock`);
  const received: HolderMessage[] = [];
  const decoder = new FrameDecoder();
  let lineBuf = '';
  let client: import('bun').Socket | null = null;

  const server = Bun.listen({
    unix: sockPath,
    socket: {
      open(sock) {
        client = sock;
        // A v2 holder announces itself the instant a server connects; a pre-v2
        // one says nothing until it has output or a cwd to report.
        if (greet) sock.write(encodeHolderHello());
      },
      data(_sock, buf) {
        if (dialect === 'legacy') {
          lineBuf += buf.toString('utf8');
          const { lines, rest } = takeLegacyLines(lineBuf);
          lineBuf = rest;
          for (const line of lines) {
            const msg = decodeLegacyHolderLine(line);
            if (msg) received.push(msg);
          }
          return;
        }
        for (const frame of decoder.push(new Uint8Array(buf))) {
          const msg = decodeHolderFrame(frame);
          if (msg) received.push(msg);
        }
      },
      close() {},
      error() {},
    },
  });

  upsertSession(id, 'bash', 'running');
  cleanups.push(() => {
    instances.get(id)?.gitWatch.dispose();
    instances.delete(id);
    deleteSession(id);
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    sockPath,
    received,
    send: (bytes) => client?.write(bytes as never),
  };
}

test('adopts a v2 holder: HELLO settles the dialect, frames flow both ways', async () => {
  const id = 'negotiate-binary';
  const holder = fakeHolder(id, 'binary', true);
  const instance = await attach(id, holder.sockPath);
  expect(instances.get(id)).toBe(instance);

  await waitFor(() => instance.link.dialect === 'binary');

  const seen: string[] = [];
  instance.subscribers.add((frame) => {
    if (frame.type === 'output') seen.push(frame.chunk);
  });
  holder.send(encodeHolderOutput(new TextEncoder().encode('hello from the pty')));
  await waitFor(() => seen.join('') === 'hello from the pty');

  expect(sendHolderInput(id, 'ls\r')).toBe(true);
  expect(sendHolderResize(id, 120, 40)).toBe(true);
  await waitFor(() => holder.received.length >= 2);
  expect(holder.received[0]).toEqual({
    type: 'input',
    data: new TextEncoder().encode('ls\r'),
  });
  expect(holder.received[1]).toEqual({ type: 'resize', cols: 120, rows: 40 });
});

test('adopts a pre-v2 holder: its JSON frames settle the dialect, and we answer in kind', async () => {
  const id = 'negotiate-legacy';
  const holder = fakeHolder(id, 'legacy', false);
  const instance = await attach(id, holder.sockPath);

  // Exactly what a live pre-v2 holder sends on connect.
  holder.send(`${JSON.stringify({ t: 'c', d: '/tmp' })}\n`);
  await waitFor(() => instance.link.dialect === 'legacy');

  const seen: string[] = [];
  instance.subscribers.add((frame) => {
    if (frame.type === 'output') seen.push(frame.chunk);
  });
  holder.send(`${JSON.stringify({ t: 'o', d: Buffer.from('legacy out').toString('base64') })}\n`);
  await waitFor(() => seen.join('') === 'legacy out');

  expect(sendHolderInput(id, 'echo hi\r')).toBe(true);
  await waitFor(() => holder.received.length >= 1);
  expect(holder.received[0]).toEqual({ type: 'input', data: Buffer.from('echo hi\r') });
});

test('a pre-v2 holder that exits is still understood', async () => {
  const id = 'negotiate-legacy-exit';
  const holder = fakeHolder(id, 'legacy', false);
  await attach(id, holder.sockPath);

  holder.send(`${JSON.stringify({ t: 'x', code: 42 })}\n`);
  // The exit handler tears the instance down — the same path the binary
  // dialect's EXIT frame takes.
  await waitFor(() => !instances.has(id));
});

test('a v2 holder that exits tears the session down the same way', async () => {
  const id = 'negotiate-binary-exit';
  const holder = fakeHolder(id, 'binary', true);
  await attach(id, holder.sockPath);
  await waitFor(() => instances.get(id)?.link.dialect === 'binary');

  holder.send(encodeHolderExit(42));
  await waitFor(() => !instances.has(id));
});

test('frames sent before the dialect is known are queued, not guessed at', async () => {
  const id = 'negotiate-queued';
  const holder = fakeHolder(id, 'binary', false); // silent on connect
  const instance = await attach(id, holder.sockPath);

  // Nothing has arrived yet, so nothing may go out — writing binary to a
  // pre-v2 holder would silently drop the resize.
  expect(instance.link.dialect).toBeNull();
  expect(sendHolderResize(id, 100, 30)).toBe(true);
  expect(holder.received).toHaveLength(0);

  // The holder finally speaks: the queue flushes in the settled dialect.
  holder.send(encodeHolderCwd('/tmp'));
  await waitFor(() => holder.received.length >= 1);
  expect(instance.link.dialect).toBe('binary');
  expect(holder.received[0]).toEqual({ type: 'resize', cols: 100, rows: 30 });
});

test('a holder that never speaks is assumed pre-v2, and the queue flushes as JSON', async () => {
  const id = 'negotiate-silent';
  // Only a pre-v2 holder can be silent on connect, so that is what we settle on.
  const holder = fakeHolder(id, 'legacy', false);
  const instance = await attach(id, holder.sockPath);
  expect(sendHolderInput(id, 'queued\r')).toBe(true);

  await waitFor(() => instance.link.dialect === 'legacy', 5_000);
  await waitFor(() => holder.received.length >= 1);
  expect(holder.received[0]).toEqual({ type: 'input', data: Buffer.from('queued\r') });
});
