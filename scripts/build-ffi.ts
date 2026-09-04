#!/usr/bin/env bun
// Builds the native tether-noise-ffi cdylib and stages it where noiseFfi.ts
// embeds it (`apps/server/src/server/noiseNativeLib`). Run before any server
// test or `bun build --compile` of the server: the server imports that file as
// a `{ type: 'file' }` asset, so it must exist and hold the correct-arch cdylib.
//
// Native only. release.yml cross-compiles the cdylib per target and copies it
// to the same destination itself before each `bun build --target=…`.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

const root = join(import.meta.dir, '..');
const manifest = join(root, 'crates/tether-noise-ffi/Cargo.toml');
const release = process.env.FFI_PROFILE === 'release';
const libSuffix =
  process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';

const profileArgs = release ? ['--release'] : [];
await $`cargo build --manifest-path ${manifest} ${profileArgs}`;

const built = join(
  root,
  'crates/tether-noise-ffi/target',
  release ? 'release' : 'debug',
  `libtether_noise_ffi.${libSuffix}`,
);
const dest = join(root, 'apps/server/src/server/noiseNativeLib');
copyFileSync(built, dest);
console.log(`build-ffi: ${built} -> ${dest}`);
