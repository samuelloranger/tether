import { httpBase, validateAddress, wsUrl } from './address';

let passed = 0;
let failed = 0;
function pass(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('FAIL:', name);
  }
}
function eq(name: string, a: unknown, b: unknown) {
  pass(name, JSON.stringify(a) === JSON.stringify(b));
}

eq('valid ipv4', validateAddress('192.168.1.10', '8085'), { ok: true });
eq('valid hostname', validateAddress('my-host.local', '8085'), { ok: true });
eq('empty host', validateAddress('', '8085'), { ok: false, reason: 'Enter a server host or IP.' });
eq('bad port', validateAddress('h', '99999'), {
  ok: false,
  reason: 'Port must be between 1 and 65535.',
});
eq('non-numeric port', validateAddress('h', 'abc'), {
  ok: false,
  reason: 'Port must be between 1 and 65535.',
});
eq('httpBase', httpBase('h', '8085'), 'http://h:8085');
eq('wsUrl', wsUrl('h', '8085', { sessionId: 'term-1', sinceId: 0 }), 'ws://h:8085/api/ws?sessionId=term-1&sinceId=0');

console.log(`address.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
