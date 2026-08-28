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
// Windows ships a raw .exe — no exec bit or quarantine to lose, unlike macOS,
// but the extension is what makes it runnable.
ok(assetName('win32', 'x64') === 'tether-windows-x64.exe', 'win32 x64');

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
// The release matrix has no windows-arm64 asset, so resolving one would send
// the user to a 404 (or, worse, a binary nobody has run there).
ok(
  throws(() => assetName('win32', 'arm64')),
  'win32 arm64 throws — x64 only',
);

ok(shouldUpdate('v1.0.9', 'v1.1.0') === true, 'different -> update');
ok(shouldUpdate('v1.1.0', 'v1.1.0') === false, 'equal -> skip');
ok(shouldUpdate('dev', 'v1.1.0') === true, 'dev -> update');

console.log(`update.test: ${pass} passed`);
