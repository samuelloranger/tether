import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { getProcessCwd } from './procCwd';

test("reads the current process's own cwd from the kernel", () => {
  expect(getProcessCwd(process.pid)).toBe(realpathSync(process.cwd()));
});

test('returns null for a pid that does not exist', () => {
  expect(getProcessCwd(2_147_483_646)).toBeNull();
});
