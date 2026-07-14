import { assetName, shouldUpdate } from './update';

let pass = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL ${msg}`);
  pass++;
}

// Linux ships the raw versioned binary; macOS wraps it in a .tar.gz.
ok(assetName('linux', 'x64', 'v1.2.0') === 'tether-linux-x64-v1.2.0', 'linux x64');
ok(assetName('linux', 'arm64', 'v1.2.0') === 'tether-linux-arm64-v1.2.0', 'linux arm64');
ok(assetName('darwin', 'arm64', 'v1.2.0') === 'tether-darwin-arm64-v1.2.0.tar.gz', 'darwin arm64');
ok(assetName('darwin', 'x64', 'v1.2.0') === 'tether-darwin-x64-v1.2.0.tar.gz', 'darwin x64');
let threw = false;
try {
  assetName('win32', 'x64', 'v1.2.0');
} catch {
  threw = true;
}
ok(threw, 'unsupported platform throws');

ok(shouldUpdate('v1.0.9', 'v1.1.0') === true, 'different -> update');
ok(shouldUpdate('v1.1.0', 'v1.1.0') === false, 'equal -> skip');
ok(shouldUpdate('dev', 'v1.1.0') === true, 'dev -> update');

console.log(`update.test: ${pass} passed`);
