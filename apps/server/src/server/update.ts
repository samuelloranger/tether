import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HIDE_CONSOLE } from './spawnWindow';

const REPO_SLUG = process.env.TETHER_REPO_SLUG ?? 'samuelloranger/tether';

// Map the running platform/arch to the release asset name. Throws on unsupported.
// Names are stable (un-versioned) so releases/latest/download/<name> is a
// one-click link. macOS ships a .tar.gz wrapping a stable inner `tether` binary
// (browser download of a raw Mach-O drops the exec bit and gets quarantined →
// Gatekeeper blocks it; a tarball extracted via CLI avoids both). Linux ships
// the raw binary; Windows ships a raw .exe, which has neither an exec bit nor
// quarantine to lose, but does need the extension to be runnable.
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os =
    platform === 'linux'
      ? 'linux'
      : platform === 'darwin'
        ? 'darwin'
        : platform === 'win32'
          ? 'windows'
          : null;
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !a) throw new Error(`Unsupported platform: ${platform}/${arch}`);
  // The release matrix builds Windows for x64 only. Windows-on-ARM does emulate
  // x64, but an emulated Bun + ConPTY is untested, so this refuses rather than
  // quietly handing an arm64 host a binary nobody has run there.
  if (os === 'windows' && a !== 'x64') throw new Error(`Unsupported platform: ${platform}/${arch}`);
  const base = `tether-${os}-${a}`;
  if (os === 'darwin') return `${base}.tar.gz`;
  if (os === 'windows') return `${base}.exe`;
  return base;
}

export function shouldUpdate(current: string, latest: string): boolean {
  return current !== latest;
}

// Compare downloaded bytes against the expected hex sha256 (case-insensitive).
export function verifyDigest(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  return actual.toLowerCase() === expectedHex.trim().toLowerCase();
}

// Parse a `sha256sum`-style manifest and return the hex digest for a filename.
export function digestForAsset(sumsText: string, assetName: string): string | null {
  for (const line of sumsText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 1].replace(/^\*/, '') === assetName) {
      return parts[0];
    }
  }
  return null;
}

/**
 * Where a displaced running binary is parked. Windows only — see swapBinary.
 * Kept next to the target (same directory, therefore same volume) so the moves
 * are pure metadata renames and cannot half-copy a 90MB file.
 */
function displacedPrefix(target: string): string {
  return `${target}.old`;
}

/**
 * Delete binaries a previous update moved aside.
 *
 * Nothing can remove them at the moment they are displaced: the update command
 * is itself executing from that image, and Windows will not unlink a mapped
 * executable. They stop being locked once every process running them has
 * exited, so the reliable moment to sweep is the start of the *next* update.
 * Best-effort throughout — a leftover is wasted disk, never a failed update.
 */
export function cleanupDisplacedBinaries(target: string): void {
  const dir = path.dirname(target);
  const prefix = path.basename(displacedPrefix(target));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      rmSync(path.join(dir, entry), { force: true });
    } catch {}
  }
}

/** A free path to park the running binary at, avoiding any still-locked leftover. */
function freeDisplacedPath(target: string): string {
  const preferred = displacedPrefix(target);
  try {
    rmSync(preferred, { force: true });
  } catch {}
  // Still there ⇒ a process from an earlier update is somehow alive and holding
  // it. Park beside it rather than failing the update over a stale file.
  return existsSync(preferred) ? `${preferred}-${Date.now()}` : preferred;
}

/**
 * Put the freshly downloaded binary at `target`.
 *
 * POSIX: one atomic rename. The running process keeps the old inode, so it is
 * unaffected, and no window exists where `target` is missing.
 *
 * Windows: overwriting a running image is refused (this is the EPERM you get
 * building over a live tether.exe), but *renaming* one is allowed — the mapping
 * follows the file, not the path. So the running binary is moved aside and the
 * new one takes the freed name. That is two renames rather than one, so the
 * second is rolled back on failure; otherwise a botched update would leave the
 * host with no tether.exe at all.
 */
export function swapBinary(tmp: string, target: string): void {
  if (process.platform !== 'win32') {
    renameSync(tmp, target);
    return;
  }
  const displaced = freeDisplacedPath(target);
  renameSync(target, displaced);
  try {
    renameSync(tmp, target);
  } catch (err) {
    renameSync(displaced, target);
    throw err;
  }
}

interface UpdateCtx {
  version: string;
  compiled: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  runningPid: () => number | null;
}

async function fetchLatestRelease(): Promise<{
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}> {
  const api = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
  const res = await fetch(api, { headers: { 'User-Agent': 'tether-update' } });
  if (!res.ok) {
    console.error(`Could not query releases (${res.status}).`);
    process.exit(1);
  }
  return (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
}

async function downloadVerifiedAsset(
  rel: { tag_name: string; assets: { name: string; browser_download_url: string }[] },
  asset: string,
): Promise<ArrayBuffer> {
  const match = rel.assets.find((x) => x.name === asset);
  if (!match) {
    console.error(`Release ${rel.tag_name} has no asset "${asset}".`);
    process.exit(1);
  }

  console.log(`Downloading ${asset} ${rel.tag_name}…`);
  const dl = await fetch(match.browser_download_url, {
    headers: { 'User-Agent': 'tether-update' },
  });
  if (!dl.ok) {
    console.error(`Download failed (${dl.status}).`);
    process.exit(1);
  }
  // Buffer the whole body first: Bun.write(path, Response) hangs on large streamed
  // bodies (repro'd on 1.3.14 with a ~90MB asset) — arrayBuffer() sidesteps it.
  const bytes = await dl.arrayBuffer();

  const sums = rel.assets.find((x) => x.name === `${asset}.sha256`);
  if (!sums) {
    console.error(`Release ${rel.tag_name} has no "${asset}.sha256" — refusing to update.`);
    process.exit(1);
  }
  const sumsRes = await fetch(sums.browser_download_url, {
    headers: { 'User-Agent': 'tether-update' },
  });
  if (!sumsRes.ok) {
    console.error(`Could not fetch checksums (${sumsRes.status}). Aborting.`);
    process.exit(1);
  }
  const expected = digestForAsset(await sumsRes.text(), asset);
  if (!expected) {
    console.error(`No published checksum for "${asset}". Aborting.`);
    process.exit(1);
  }
  if (!verifyDigest(new Uint8Array(bytes), expected)) {
    console.error('Update checksum mismatch — aborting (possible tampering).');
    process.exit(1);
  }
  return bytes;
}

async function stageUpdateBinary(dir: string, asset: string, bytes: ArrayBuffer): Promise<string> {
  if (asset.endsWith('.tar.gz')) {
    // macOS: extract the inner `tether` into a staging dir (same filesystem as
    // target so the final rename stays atomic). tar is present on macOS/Linux.
    const staging = path.join(dir, '.tether-update');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const archive = path.join(staging, 'tether.tar.gz');
    await Bun.write(archive, bytes);
    const ex = Bun.spawnSync(['tar', 'xzf', archive, '-C', staging, 'tether'], HIDE_CONSOLE);
    if (!ex.success) {
      console.error(`Failed to extract ${asset}. Aborting.`);
      rmSync(staging, { recursive: true, force: true });
      process.exit(1);
    }
    return path.join(staging, 'tether');
  }
  const tmp = path.join(dir, '.tether.new');
  await Bun.write(tmp, bytes);
  return tmp;
}

export async function runUpdate(ctx: UpdateCtx): Promise<void> {
  if (!ctx.compiled) {
    console.error('update only works on an installed binary. In dev, use git + bun run.');
    process.exit(1);
  }
  // Sweep whatever the previous update had to leave behind (Windows only, and
  // a no-op everywhere else). Done before the download so a repeat update never
  // accumulates ~90MB images, and done here rather than at daemon boot because
  // this is the first moment nothing can still be executing them.
  cleanupDisplacedBinaries(process.execPath);
  console.log('Checking latest release…');
  const rel = await fetchLatestRelease();
  if (!shouldUpdate(ctx.version, rel.tag_name)) {
    console.log(`Already up to date (${ctx.version}).`);
    return;
  }
  const asset = assetName(process.platform, process.arch);
  const bytes = await downloadVerifiedAsset(rel, asset);

  const target = process.execPath;
  const dir = path.dirname(target);
  const tmp = await stageUpdateBinary(dir, asset, bytes);
  // Windows has no exec bit, and node maps chmod there onto the read-only
  // attribute — a mode this never wants to set.
  if (process.platform !== 'win32') chmodSync(tmp, 0o755);

  const wasRunning = ctx.runningPid() !== null;
  const staging = asset.endsWith('.tar.gz') ? path.join(dir, '.tether-update') : null;
  swapBinary(tmp, target);
  if (staging) rmSync(staging, { recursive: true, force: true });
  console.log(`Updated to ${rel.tag_name}.`);
  if (wasRunning) {
    console.log('Restarting server…');
    await ctx.stop();
    await ctx.start();
  } else {
    console.log('Server not running. Start it with: tether start');
  }
}
