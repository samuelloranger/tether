import { describe, expect, test } from 'bun:test';
import {
  assetUrl,
  buildManifest,
  pairSignatures,
  platformKeysFor,
  REQUIRED_PLATFORMS,
} from './build-updater-manifest';

const REPO = 'samuelloranger/tether';
const TAG = 'v2.8.12';

/** The full set of signed bundles a green release produces. */
const bundles = () => [
  'Tether_aarch64.app.tar.gz',
  'Tether_x64.app.tar.gz',
  'Tether_2.8.12_amd64.AppImage',
  'Tether_2.8.12_amd64.deb',
  'Tether-2.8.12-1.x86_64.rpm',
  'Tether_2.8.12_x64_en-US.msi',
  'Tether_2.8.12_x64-setup.exe',
].map((name) => ({ name, url: assetUrl(REPO, TAG, name), signature: 'sig' }));

describe('assetUrl', () => {
  // v2.8.12 shipped a manifest built from each asset's browser_download_url.
  // This runs while the release is a draft, where that URL carries a
  // placeholder tag, so every updater link 404'd the moment it published.
  test('builds from the tag, never a draft placeholder', () => {
    expect(assetUrl(REPO, TAG, 'Tether_2.8.12_amd64.deb')).toBe(
      'https://github.com/samuelloranger/tether/releases/download/v2.8.12/Tether_2.8.12_amd64.deb',
    );
  });

  test('every manifest URL points at the tag', () => {
    const manifest = buildManifest('2.8.12', '', 'now', bundles());
    for (const [key, entry] of Object.entries(manifest.platforms)) {
      expect(`${key}:${entry.url}`).toContain(`/releases/download/${TAG}/`);
      expect(entry.url).not.toContain('untagged-');
    }
  });

  test('pairSignatures ignores the draft URLs gh reports', () => {
    const assets = [{ name: 'Tether_2.8.12_amd64.deb' }, { name: 'Tether_2.8.12_amd64.deb.sig' }];
    const [bundle] = pairSignatures(assets, REPO, TAG, () => '  sigtext\n');
    expect(bundle.url).toBe(assetUrl(REPO, TAG, 'Tether_2.8.12_amd64.deb'));
    expect(bundle.signature).toBe('sigtext');
  });

  test('a .sig with no bundle is an error, not a silent skip', () => {
    expect(() => pairSignatures([{ name: 'ghost.deb.sig' }], REPO, TAG, () => 'x')).toThrow(
      /no matching bundle/,
    );
  });
});

describe('platformKeysFor', () => {
  test.each([
    ['Tether_aarch64.app.tar.gz', ['darwin-aarch64', 'darwin-aarch64-app']],
    ['Tether_x64.app.tar.gz', ['darwin-x86_64', 'darwin-x86_64-app']],
    ['Tether_2.8.12_amd64.AppImage', ['linux-x86_64', 'linux-x86_64-appimage']],
    ['Tether_2.8.12_amd64.deb', ['linux-x86_64-deb']],
    ['Tether-2.8.12-1.x86_64.rpm', ['linux-x86_64-rpm']],
    ['Tether_2.8.12_x64_en-US.msi', ['windows-x86_64', 'windows-x86_64-msi']],
    ['Tether_2.8.12_x64-setup.exe', ['windows-x86_64-nsis']],
  ])('%s', (name, keys) => {
    expect(platformKeysFor(name)).toEqual(keys);
  });

  test('the .dmg is not an updater target', () => {
    expect(platformKeysFor('Tether_2.8.12_x64.dmg')).toEqual([]);
  });

  test('an unrecognised arch is an error rather than a guess', () => {
    expect(() => platformKeysFor('Tether_2.8.12_riscv64.deb')).toThrow(/architecture/);
  });
});

describe('buildManifest', () => {
  test('a complete release covers every required platform', () => {
    const manifest = buildManifest('2.8.12', '', 'now', bundles());
    expect(Object.keys(manifest.platforms).sort()).toEqual([...REQUIRED_PLATFORMS].sort());
  });

  // The merge this replaced dropped platforms silently; holding the release as
  // a draft is the whole reason this is a hard error.
  test('a missing build leg fails instead of stranding that platform', () => {
    const withoutRpm = bundles().filter((b) => !b.name.endsWith('.rpm'));
    expect(() => buildManifest('2.8.12', '', 'now', withoutRpm)).toThrow(/linux-x86_64-rpm/);
  });

  test('two assets claiming one platform is an error', () => {
    const dupes = [
      { name: 'Tether_x64.app.tar.gz', url: 'a', signature: 's' },
      { name: 'Other_x64.app.tar.gz', url: 'b', signature: 's' },
    ];
    expect(() => buildManifest('2.8.12', '', 'now', dupes)).toThrow(/two assets claim/);
  });
});
