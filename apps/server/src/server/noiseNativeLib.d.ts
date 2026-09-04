// Ambient type for the embedded cdylib file asset (imported in noiseFfi.ts with
// `{ type: 'file' }`). `bun build` bundles the real file; the default export is a
// runtime path string to it. The asset itself (sibling `noiseNativeLib`, with no
// extension) is produced by scripts/build-ffi.ts and gitignored.
declare const noiseNativeLibPath: string;
export default noiseNativeLibPath;
