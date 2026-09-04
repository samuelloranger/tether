#!/usr/bin/env bun
// Builds the tether-noise-ffi cdylib and stages it where noiseFfi.ts embeds it
// (`apps/server/src/server/noiseNativeLib`). Run before any server test or
// `bun build --compile` of the server: the server imports that file as a
// `{ type: 'file' }` asset, so it must exist and hold the correct-arch cdylib.
//
// Env:
//   FFI_PROFILE=release   build the release cdylib (default: debug)
//   FFI_TARGET=<triple>   cross-compile for a Rust target triple (default: host)
//                         e.g. aarch64-unknown-linux-gnu, x86_64-apple-darwin
//
// The default (no env) is the host debug build used by dev and `bun run test`.
// release.yml sets FFI_PROFILE=release and, per matrix leg, FFI_TARGET.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

const root = join(import.meta.dir, '..');
const manifest = join(root, 'crates/tether-noise-ffi/Cargo.toml');
const release = process.env.FFI_PROFILE === 'release';
const target = process.env.FFI_TARGET?.trim() || '';

// The cdylib's filename shape follows the *target*, not the build host: Apple
// targets emit `lib….dylib`, Windows `….dll` (no `lib` prefix), everything else
// `lib….so`. Fall back to the host platform when no target is pinned.
function platformOf(triple: string): 'windows' | 'darwin' | 'linux' {
  if (triple) {
    if (triple.includes('windows')) return 'windows';
    if (triple.includes('apple') || triple.includes('darwin')) return 'darwin';
    return 'linux';
  }
  return process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';
}
const platform = platformOf(target);
const libSuffix = platform === 'windows' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';
const libPrefix = platform === 'windows' ? '' : 'lib';

const profileArgs = release ? ['--release'] : [];
const targetArgs = target ? ['--target', target] : [];
await $`cargo build --manifest-path ${manifest} ${profileArgs} ${targetArgs}`;

// cargo nests the artifact under target/<triple>?/<profile>/.
const builtDir = join(
  root,
  'crates/tether-noise-ffi/target',
  target,
  release ? 'release' : 'debug',
);
const built = join(builtDir, `${libPrefix}tether_noise_ffi.${libSuffix}`);
const dest = join(root, 'apps/server/src/server/noiseNativeLib');
copyFileSync(built, dest);
console.log(`build-ffi: ${built} -> ${dest}`);
