// Component tests only. Pure-logic tests stay on `bun test` (fast, no RN
// runtime) — that split is why testMatch is scoped to __tests__/*.spec.tsx and
// the bun script is scoped to src/: neither runner may pick up the other's
// files, since bun's default glob matches *.spec.* too.
//
// The preset is React Native's, not jest-expo's. jest-expo installs expo's
// "winter" globals (fetch, structuredClone, URL, __ExpoImportMetaRegistry, …)
// as lazy getters that require() the winter runtime on first touch; jest rejects
// any require issued while it considers itself outside test code, and setup
// touches several of them, so every suite dies before its first test. The
// components under test need only a handful of expo modules, mocked directly in
// jest-setup.ts.
//
// rootDir is the workspace root, not apps/mobile: bun installs dependencies
// there, isolated under node_modules/.bun/…, and jest will not execute requires
// that resolve outside rootDir.
const path = require('node:path');

const mobile = '<rootDir>/apps/mobile';
// Resolved explicitly: with rootDir at the workspace root, jest looks for the
// preset relative to rootDir and misses bun's isolated install layout.
const rnPreset = path.dirname(require.resolve('@react-native/jest-preset/package.json'));

module.exports = {
  preset: rnPreset,
  rootDir: '../..',
  testMatch: [`${mobile}/__tests__/**/*.spec.tsx`],
  setupFilesAfterEnv: [`${mobile}/jest-setup.ts`],
  // Bun installs isolated: real paths are node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/…
  // The stock ignore pattern assumes a hoisted layout, sees ".bun" as the package
  // name, and skips transforming React Native's ESM source — which fails as
  // "Cannot use import statement outside a module". Match the package name where
  // it actually sits: right after ".bun/".
  // @xterm/* ships prebundled modern JS (static class blocks) that the RN babel
  // preset cannot parse and does not need to: leave it untransformed.
  transformIgnorePatterns: [
    'node_modules/\\.bun/(?!(@?react-native|@react-native-.*|@?expo|expo-.*|@expo/.*|@testing-library|react-clone-referenced-element)[^/]*/)',
  ],
  // Inline, rather than a repo babel.config.js: Metro reads that file too, and
  // the app deliberately has none. RN's jest setup is Flow-typed, so the default
  // babel-jest config cannot parse it.
  // Key must match the RN preset's exactly, or its own entry survives the merge
  // and jest tries to resolve a bare "babel-jest" from rootDir — which bun's
  // isolated layout does not expose there.
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      require.resolve('babel-jest'),
      {
        presets: [require.resolve('@react-native/babel-preset')],
        babelrc: false,
        configFile: false,
      },
    ],
    '^.+\\.(js|ts|tsx)$': [
      require.resolve('babel-jest'),
      {
        presets: [require.resolve('@react-native/babel-preset')],
        babelrc: false,
        configFile: false,
      },
    ],
  },
  moduleNameMapper: {
    // A ~1MB generated string; no component test needs its contents.
    'terminalRenderer\\.generated$': `${mobile}/__tests__/mocks/rendererBundle.ts`,
  },
};
