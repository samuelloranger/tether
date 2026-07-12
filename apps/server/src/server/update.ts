import { chmodSync, renameSync } from 'node:fs';
import path from 'node:path';

const REPO_SLUG = process.env.TETHER_REPO_SLUG ?? 'samuelloranger/tether';

// Map the running platform/arch to the release asset name. Throws on unsupported.
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : null;
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !a) throw new Error(`Unsupported platform: ${platform}/${arch}`);
  return `tether-${os}-${a}`;
}

export function shouldUpdate(current: string, latest: string): boolean {
  return current !== latest;
}

interface UpdateCtx {
  version: string;
  compiled: boolean;
  start: () => void;
  stop: () => void;
  runningPid: () => number | null;
}

export async function runUpdate(ctx: UpdateCtx): Promise<void> {
  if (!ctx.compiled) {
    console.error('update only works on an installed binary. In dev, use git + bun run.');
    process.exit(1);
  }
  const asset = assetName(process.platform, process.arch);
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
  const target = process.execPath;
  const tmp = path.join(path.dirname(target), '.tether.new');
  await Bun.write(tmp, dl);
  chmodSync(tmp, 0o755);

  // Sanity-check the downloaded binary before swapping it in.
  const check = Bun.spawnSync([tmp, 'version']);
  const printed = check.stdout.toString().trim();
  if (!check.success || printed !== rel.tag_name) {
    console.error(`Downloaded binary failed self-check (got "${printed}"). Aborting.`);
    process.exit(1);
  }

  const wasRunning = ctx.runningPid() !== null;
  renameSync(tmp, target); // atomic swap; running process keeps the old inode
  console.log(`Updated to ${rel.tag_name}.`);
  if (wasRunning) {
    console.log('Restarting server…');
    ctx.stop();
    ctx.start();
  } else {
    console.log('Server not running. Start it with: tether start');
  }
}
