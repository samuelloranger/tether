import { assetName, shouldUpdate } from './update';

let pass = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL ${msg}`);
  pass++;
}

// Stable (un-versioned) names; macOS wraps the binary in a .tar.gz.
ok(assetName('linux', 'x64') === 'tether-linux-x64', 'linux x64');
ok(assetName('linux', 'arm64') === 'tether-linux-arm64', 'linux arm64');
ok(assetName('darwin', 'arm64') === 'tether-darwin-arm64.tar.gz', 'darwin arm64');
ok(assetName('darwin', 'x64') === 'tether-darwin-x64.tar.gz', 'darwin x64');

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
ok(
  throws(() => assetName('freebsd', 'x64')),
  'unsupported platform throws',
);
ok(
  throws(() => assetName('linux', 'riscv64')),
  'unsupported arch throws',
);
// Windows is not a supported server platform, so it resolves to nothing
// rather than to an asset the release matrix no longer builds.
ok(
  throws(() => assetName('win32', 'x64')),
  'win32 throws — not a supported server platform',
);

ok(shouldUpdate('v1.0.9', 'v1.1.0') === true, 'different -> update');
ok(shouldUpdate('v1.1.0', 'v1.1.0') === false, 'equal -> skip');
ok(shouldUpdate('dev', 'v1.1.0') === true, 'dev -> update');

console.log(`update.test: ${pass} passed`);
