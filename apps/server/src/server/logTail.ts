import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// A `tail -n N -f` in TypeScript, used by `tether logs`.
//
// This replaces the tail(1) subprocess on EVERY platform, not just Windows.
// Windows forces the question — there is no tail.exe outside a Git for Windows
// PATH, so `tether logs` died with ENOENT on a clean box — and once the follow
// loop has to exist here anyway, keeping a second POSIX-only implementation
// buys nothing: the log is a single append-only file that only the daemon
// writes, so the one thing tail(1) does better (surviving log rotation) is not
// in play. Plain `tail -f` follows the fd and would go silent on a rename
// anyway; the size-shrank check below actually handles in-place truncation,
// which is the rotation shape a copytruncate logrotate would produce.
//
// It also fixes a lifetime bug: `spawn('tail', …, {stdio:'inherit'})` let the
// parent CLI return immediately and leave an orphan holding the terminal, so
// Ctrl-C raced the child. Here the poll timer keeps the event loop alive and
// Ctrl-C kills the one process the user started.

// Read backwards a chunk at a time so following a log that has grown to
// hundreds of MB does not read hundreds of MB to print 80 lines.
const READ_CHUNK = 64 * 1024;
const DEFAULT_LINES = 80;
// fs.watch is not usable here: on Windows ReadDirectoryChangesW does not
// reliably fire for appends to an already-open handle, so a watcher can sit
// silent while the log grows. Polling a stat is boring and works everywhere.
const DEFAULT_INTERVAL_MS = 250;

export type FollowHandle = {
  /** Stop polling and let the process exit. */
  stop(): void;
};

export type FollowOptions = {
  /** How many trailing lines to print before following. Default 80. */
  lines?: number;
  /** Poll interval for appends. Default 250ms. */
  intervalMs?: number;
  /** Sink for both the initial tail and every append. Default stdout. */
  write?: (chunk: string) => void;
};

/**
 * The last `n` lines of `text`, preserving whether the input ended with a
 * newline. A file shorter than `n` lines comes back whole; empty in, empty out.
 */
export function lastLines(text: string, n: number): string {
  if (n <= 0 || text === '') return '';
  // A trailing newline terminates the final line, it does not start an empty
  // one — split() disagrees, so peel it off and put it back at the end.
  const terminated = text.endsWith('\n');
  const lines = (terminated ? text.slice(0, -1) : text).split('\n');
  const kept = lines.slice(Math.max(0, lines.length - n));
  return kept.join('\n') + (terminated ? '\n' : '');
}

export type TailResult = {
  /** The trailing lines, ready to print. */
  text: string;
  /** File size in bytes at the moment it was read — where following starts. */
  size: number;
};

/**
 * Read the last `n` lines of a file without reading the whole thing. Returns
 * the size it read to, so a follower knows the offset to resume from without
 * re-stat'ing and racing an append that landed in between.
 */
export function readLastLines(file: string, n: number = DEFAULT_LINES): TailResult {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    let pos = size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    // Walk backwards until we hold more line terminators than we need, so the
    // first kept line is known to be complete rather than a chunk fragment.
    while (pos > 0 && newlines <= n) {
      const len = Math.min(READ_CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, pos);
      const chunk = buf.subarray(0, read);
      for (const byte of chunk) if (byte === 0x0a) newlines++;
      chunks.unshift(chunk);
    }
    // Decode once, at the end: a chunk boundary can split a multi-byte UTF-8
    // sequence, and decoding each chunk on its own would turn it into U+FFFD.
    return { text: lastLines(Buffer.concat(chunks).toString('utf8'), n), size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Print the last `lines` lines of `file`, then stream every append until
 * `stop()`. The returned handle's timer keeps the process alive on purpose —
 * this is the whole body of `tether logs`.
 */
export function followFile(file: string, options: FollowOptions = {}): FollowHandle {
  const { lines = DEFAULT_LINES, intervalMs = DEFAULT_INTERVAL_MS } = options;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));

  const start = readLastLines(file, lines);
  if (start.text) write(start.text);

  let offset = start.size;
  // A write can flush mid-character, so carry the partial sequence across polls
  // instead of emitting a replacement char for it. Replaced (not reused) on an
  // in-place truncation below: bytes buffered from the pre-truncation content
  // are gone, and feeding them ahead of the new content corrupts its first char.
  let decoder = new StringDecoder('utf8');

  const poll = () => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      // The log vanished (rotated away, or ~/.tether wiped). Keep following the
      // path rather than exiting — the daemon recreates it on its next write.
      return;
    }
    // Shrank ⇒ truncated in place. Start over from the top; the alternative is
    // sitting at a stale offset past EOF and never printing anything again.
    // Drop the decoder's partial-byte carry too: it belongs to content that no
    // longer exists, and prepending it to the new bytes garbles the first char.
    if (size < offset) {
      offset = 0;
      decoder = new StringDecoder('utf8');
    }
    if (size === offset) return;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      offset += read;
      if (read > 0) write(decoder.write(buf.subarray(0, read)));
    } finally {
      closeSync(fd);
    }
  };

  const timer = setInterval(poll, intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
