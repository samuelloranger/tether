#!/usr/bin/env bun
/**
 * Builds the Tauri updater manifest (`latest.json`) for a release, once, from
 * the signed bundles already attached to it.
 *
 * Why this exists instead of letting tauri-action do it: tauri-action maintains
 * latest.json by read-modify-write — fetch the existing asset, merge in this
 * platform, delete it, re-upload. Every desktop matrix leg does that against the
 * same release, so the legs race. In v2.8.11 one leg deleted the asset another
 * was reading and failed the run with "Not Found - get-a-release-asset" after
 * its bundles were already uploaded. The quieter and worse outcome of the same
 * race is a lost update that drops a platform from the manifest, which breaks
 * in-app updates for those users with no failed job to notice.
 *
 * So the legs keep running in parallel with `includeUpdaterJson: false` (they
 * still upload their own uniquely-named bundles and .sig files, which never
 * collide), and this runs afterwards as the single writer.
 *
 * Unlike the merge it replaces, a missing platform is a hard error: better to
 * hold the release as a draft than to publish a manifest that silently strands
 * a platform on an old version.
 */

import { readFileSync } from 'node:fs';

/** One signed updater bundle attached to the release. */
export interface SignedBundle {
  /** Asset filename, e.g. `Tether_2.8.11_amd64.AppImage`. */
  name: string;
  /** Public download URL for that asset. */
  url: string;
  /** Contents of the matching `.sig` asset. */
  signature: string;
}

/**
 * The URL an asset will have once the release is published.
 *
 * Deliberately built from the tag rather than read from the asset's
 * `browser_download_url`: this runs while the release is still a draft, and a
 * draft's download URLs carry a placeholder tag (`untagged-<hash>`) that stops
 * resolving the moment it is published. v2.8.12 shipped a manifest full of
 * those and every updater URL 404'd.
 */
export function assetUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

export interface UpdaterManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/**
 * Every platform key the updater must be able to resolve. Derived from the
 * desktop matrix; kept explicit so that losing a build leg fails loudly here
 * rather than shipping a manifest that is quietly missing a platform.
 */
export const REQUIRED_PLATFORMS = [
  'darwin-aarch64',
  'darwin-aarch64-app',
  'darwin-x86_64',
  'darwin-x86_64-app',
  'linux-x86_64',
  'linux-x86_64-appimage',
  'linux-x86_64-deb',
  'linux-x86_64-rpm',
  'windows-x86_64',
  'windows-x86_64-msi',
  'windows-x86_64-nsis',
] as const;

/** Normalises the arch as it appears in bundle filenames to the updater's spelling. */
function archOf(name: string): 'x86_64' | 'aarch64' {
  if (/aarch64|arm64/.test(name)) return 'aarch64';
  if (/x86_64|x64|amd64/.test(name)) return 'x86_64';
  throw new Error(`cannot determine architecture from asset name: ${name}`);
}

/**
 * Maps a signed bundle to the updater platform keys it serves.
 *
 * The bare `<os>-<arch>` key is the default a client falls back to when it does
 * not ask for a specific installer format, so each OS points it at the format
 * tauri-action chose: the .app tarball on macOS, the AppImage on Linux, and the
 * MSI on Windows (`updaterJsonPreferNsis` is not set). Returns [] for assets
 * that are not updater targets at all, such as the macOS .dmg.
 */
export function platformKeysFor(name: string): string[] {
  if (name.endsWith('.app.tar.gz')) {
    const arch = archOf(name);
    return [`darwin-${arch}`, `darwin-${arch}-app`];
  }
  if (name.endsWith('.AppImage')) {
    const arch = archOf(name);
    return [`linux-${arch}`, `linux-${arch}-appimage`];
  }
  if (name.endsWith('.deb')) return [`linux-${archOf(name)}-deb`];
  if (name.endsWith('.rpm')) return [`linux-${archOf(name)}-rpm`];
  if (name.endsWith('.msi')) {
    const arch = archOf(name);
    return [`windows-${arch}`, `windows-${arch}-msi`];
  }
  if (name.endsWith('-setup.exe')) return [`windows-${archOf(name)}-nsis`];
  return [];
}

/** Assembles the manifest, refusing to emit one that is missing a platform. */
export function buildManifest(
  version: string,
  notes: string,
  pubDate: string,
  bundles: SignedBundle[],
): UpdaterManifest {
  const platforms: UpdaterManifest['platforms'] = {};
  for (const bundle of bundles) {
    for (const key of platformKeysFor(bundle.name)) {
      const existing = platforms[key];
      if (existing && existing.url !== bundle.url) {
        throw new Error(
          `two assets claim platform ${key}: ${existing.url} and ${bundle.url}`,
        );
      }
      platforms[key] = { signature: bundle.signature, url: bundle.url };
    }
  }

  const missing = REQUIRED_PLATFORMS.filter((key) => !platforms[key]);
  if (missing.length > 0) {
    throw new Error(
      `updater manifest is missing ${missing.length} platform(s): ${missing.join(', ')}\n` +
        `Found: ${Object.keys(platforms).sort().join(', ') || '(none)'}\n` +
        'A build leg probably failed to upload its signed bundle. Fix that leg and ' +
        're-run; publishing this manifest would strand those platforms on the old version.',
    );
  }

  return { version, notes, pub_date: pubDate, platforms };
}

// --- CLI -------------------------------------------------------------------

interface GhAsset {
  name: string;
}

/** Pairs each `<bundle>.sig` asset with its bundle and that signature's text. */
export function pairSignatures(
  assets: GhAsset[],
  repo: string,
  tag: string,
  readSignature: (sigName: string) => string,
): SignedBundle[] {
  const names = new Set(assets.map((a) => a.name));
  const bundles: SignedBundle[] = [];
  for (const asset of assets) {
    if (!asset.name.endsWith('.sig')) continue;
    const bundleName = asset.name.slice(0, -'.sig'.length);
    if (!names.has(bundleName)) throw new Error(`${asset.name} has no matching bundle asset`);
    bundles.push({
      name: bundleName,
      url: assetUrl(repo, tag, bundleName),
      signature: readSignature(asset.name).trim(),
    });
  }
  return bundles;
}

if (import.meta.main) {
  const [tag, outPath = 'latest.json'] = process.argv.slice(2);
  if (!tag) {
    console.error('usage: bun scripts/build-updater-manifest.ts <tag> [outPath]');
    process.exit(2);
  }

  const repo =
    process.env.GITHUB_REPOSITORY ??
    (await Bun.$`gh repo view --json nameWithOwner -q .nameWithOwner`.text()).trim();
  if (!repo) throw new Error('cannot determine the repository (set GITHUB_REPOSITORY)');

  const view = await Bun.$`gh release view ${tag} --json assets,body`.json();
  const assets = (view.assets ?? []) as GhAsset[];

  // Draft asset URLs are not publicly fetchable yet, so pull the signatures
  // through gh rather than over HTTP.
  const sigDir = '.updater-sigs';
  await Bun.$`rm -rf ${sigDir}`;
  await Bun.$`mkdir -p ${sigDir}`;
  await Bun.$`gh release download ${tag} --pattern '*.sig' --dir ${sigDir} --clobber`;

  const bundles = pairSignatures(assets, repo, tag, (sigName) =>
    readFileSync(`${sigDir}/${sigName}`, 'utf8'),
  );

  const version = tag.replace(/^v/, '');
  const manifest = buildManifest(version, '', new Date().toISOString(), bundles);

  // The draft-URL bug was invisible until an updater actually followed a link,
  // so assert the shape here rather than trusting it.
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    if (!entry.url.includes(`/releases/download/${tag}/`)) {
      throw new Error(`platform ${key} has a non-tag download URL: ${entry.url}`);
    }
  }
  await Bun.write(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Wrote ${outPath}: ${Object.keys(manifest.platforms).length} platforms for v${version}`,
  );
}
