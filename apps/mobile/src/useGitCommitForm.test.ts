import { expect, test } from 'bun:test';
import { submitGitMessage } from './useGitCommitForm';

test('submitGitMessage trims and reports success', async () => {
  let seen = '';
  const ok = await submitGitMessage('  hello  ', false, async (message) => {
    seen = message;
    return true;
  });
  expect(ok).toBe(true);
  expect(seen).toBe('hello');
});

test('submitGitMessage no-ops when empty or already committing', async () => {
  let calls = 0;
  const submit = async () => {
    calls += 1;
    return true;
  };
  expect(await submitGitMessage('   ', false, submit)).toBe(false);
  expect(await submitGitMessage('x', true, submit)).toBe(false);
  expect(calls).toBe(0);
});

test('submitGitMessage reports failure without claiming success', async () => {
  expect(await submitGitMessage('msg', false, async () => false)).toBe(false);
});
