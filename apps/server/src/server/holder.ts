// PTY holder: a tiny detached process that owns one session's PTY so the shell
// (and everything running in it — claude, builds, ssh) survives tether server
// restarts. The server talks to it over a unix socket with newline-delimited
// JSON frames; base64 payloads keep the byte stream binary-safe.
//
//   server -> holder: {t:'i', d}(input b64) {t:'r', c, r}(resize) {t:'k'}(kill)
//   holder -> server: {t:'o', d}(output b64) {t:'x', code}(pty exit)
//
// Usage: bun run holder.ts <socketPath> <cols> <rows> <cwd> <cmd> [args...]

import { unlinkSync, writeFileSync } from 'node:fs';

const [socketPath, colsArg, rowsArg, cwd, ...cmdArgs] = process.argv.slice(2);
if (!socketPath || cmdArgs.length === 0) {
  console.error('usage: holder.ts <socketPath> <cols> <rows> <cwd> <cmd> [args...]');
  process.exit(2);
}

// ponytail: 2MB ring of pending output while no server is attached — enough
// for a restart window; oldest frames drop first if a firehose runs unattached.
const BUFFER_CAP = 2_000_000;
let buffered: string[] = [];
let bufferedBytes = 0;
let client: import('bun').Socket | null = null;

function sendFrame(frame: string, rawLen: number) {
  if (client) {
    client.write(frame);
    return;
  }
  buffered.push(frame);
  bufferedBytes += rawLen;
  while (bufferedBytes > BUFFER_CAP && buffered.length > 1) {
    const dropped = buffered.shift();
    if (dropped) bufferedBytes -= dropped.length;
  }
}

const proc = Bun.spawn(cmdArgs, {
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' },
  terminal: {
    cols: Number(colsArg) || 80,
    rows: Number(rowsArg) || 24,
    data(_terminal, bytes) {
      const d = Buffer.from(bytes).toString('base64');
      sendFrame(`${JSON.stringify({ t: 'o', d })}\n`, bytes.length);
    },
  },
});

try {
  unlinkSync(socketPath); // stale socket from a crashed predecessor
} catch {}

let lineBuf = '';
const server = Bun.listen({
  unix: socketPath,
  socket: {
    open(sock) {
      // One server at a time: a reconnecting tether server replaces the old link.
      if (client) client.end();
      client = sock;
      for (const frame of buffered) sock.write(frame);
      buffered = [];
      bufferedBytes = 0;
    },
    data(_sock, buf) {
      lineBuf += buf.toString('utf8');
      let nl = lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        nl = lineBuf.indexOf('\n');
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.t === 'i' && proc.terminal) {
            proc.terminal.write(Buffer.from(msg.d, 'base64').toString('utf8'));
          } else if (msg.t === 'r' && proc.terminal) {
            proc.terminal.resize(msg.c, msg.r);
          } else if (msg.t === 'k') {
            killPty();
          }
        } catch {}
      }
    },
    close(sock) {
      if (client === sock) client = null; // detached — keep running, buffer output
    },
    error() {},
  },
});

function cleanup() {
  try {
    unlinkSync(socketPath);
  } catch {}
  try {
    unlinkSync(`${socketPath}.pid`);
  } catch {}
}

proc.exited.then((code) => {
  sendFrame(`${JSON.stringify({ t: 'x', code })}\n`, 0);
  // Give the attached server a beat to read the exit frame before dying.
  setTimeout(() => {
    server.stop(true);
    cleanup();
    process.exit(code ?? 0);
  }, 150);
});

// Interactive shells ignore SIGTERM; SIGHUP is the "terminal went away" signal
// they honor. Escalate to SIGKILL for anything that ignores both.
function killPty() {
  proc.kill('SIGHUP');
  setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }, 1000);
}

process.on('SIGTERM', killPty);

writeFileSync(`${socketPath}.pid`, String(process.pid));
