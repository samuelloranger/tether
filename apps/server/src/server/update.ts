import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const REPO_SLUG = process.env.TETHER_REPO_SLUG ?? 'samuelloranger/tether';

// Map the running platform/arch to the release asset name. Throws on unsupported.
// macOS ships a .tar.gz wrapping a stable inner `tether` binary (browser download
// of a raw Mach-O drops the exec bit and gets quarantined → Gatekeeper blocks it;
// a tarball extracted via CLI avoids both). Linux ships the raw binary.
export function assetName(platform: NodeJS.Platform, arch: string, version: string): string {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : null;
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !a) throw new Error(`Unsupported platform: ${platform}/${arch}`);
  const base = `tether-${os}-${a}-${version}`;
  return os === 'darwin' ? `${base}.tar.gz` : base;
}

export function shouldUpdate(current: string, latest: string): boolean {
  return current !== latest;
}

interface UpdateCtx {
  version: string;
  compiled: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  runningPid: () => number | null;
}

export async function runUpdate(ctx: UpdateCtx): Promise<void> {
  if (!ctx.compiled) {
    console.error('update only works on an installed binary. In dev, use git + bun run.');
    process.exit(1);
  }
  console.log('Checking latest release…');
  const api = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
  const res = await fetch(api, { headers: { 'User-Agent': 'tether-update' } });
  if (!res.ok) {
    console.error(`Could not query releases (${res.status}).`);
    process.exit(1);
  }
  const rel = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  if (!shouldUpdate(ctx.version, rel.tag_name)) {
    console.log(`Already up to date (${ctx.version}).`);
    return;
  }
  // Asset name embeds the release tag, so resolve it after we know the tag.
  const asset = assetName(process.platform, process.arch, rel.tag_name);
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
  // Write next to the current binary so the final rename is same-filesystem/atomic.
  // Buffer the whole body first: Bun.write(path, Response) hangs on large streamed
  // bodies (repro'd on 1.3.14 with a ~90MB asset) — arrayBuffer() sidesteps it.
  const target = process.execPath;
  const dir = path.dirname(target);
  const bytes = await dl.arrayBuffer();

  let tmp: string;
  let staging: string | null = null;
  if (asset.endsWith('.tar.gz')) {
    // macOS: extract the inner `tether` into a staging dir (same filesystem as
    // target so the final rename stays atomic). tar is present on macOS/Linux.
    staging = path.join(dir, '.tether-update');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const archive = path.join(staging, 'tether.tar.gz');
    await Bun.write(archive, bytes);
    const ex = Bun.spawnSync(['tar', 'xzf', archive, '-C', staging, 'tether']);
    if (!ex.success) {
      console.error(`Failed to extract ${asset}. Aborting.`);
      rmSync(staging, { recursive: true, force: true });
      process.exit(1);
    }
    tmp = path.join(staging, 'tether');
  } else {
    tmp = path.join(dir, '.tether.new');
    await Bun.write(tmp, bytes);
  }
  chmodSync(tmp, 0o755);

  // Sanity-check the downloaded binary before swapping it in.
  const check = Bun.spawnSync([tmp, 'version']);
  const printed = check.stdout.toString().trim();
  if (!check.success || printed !== rel.tag_name) {
    console.error(`Downloaded binary failed self-check (got "${printed}"). Aborting.`);
    if (staging) rmSync(staging, { recursive: true, force: true });
    process.exit(1);
  }

  const wasRunning = ctx.runningPid() !== null;
  renameSync(tmp, target); // atomic swap; running process keeps the old inode
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
