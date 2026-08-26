import { describe, expect, test } from 'bun:test';
import { normalizeInvokeError } from './invokeError';

describe('normalizeInvokeError', () => {
  test('passes an Error through untouched', () => {
    const original = new Error('already an error');
    expect(normalizeInvokeError(original)).toBe(original);
  });

  test('keeps the message of a string rejection — the case that regressed', () => {
    // Tauri rejects `Result<_, String>` commands with the bare string, which is
    // why every add-host failure collapsed to "Could not save host.".
    expect(normalizeInvokeError('Unreachable — check the host and port.').message).toBe(
      'Unreachable — check the host and port.',
    );
    expect(normalizeInvokeError('Wrong password.').message).toBe('Wrong password.');
  });

  test('prefers a readable field over [object Object]', () => {
    expect(normalizeInvokeError({ message: 'from message' }).message).toBe('from message');
    expect(normalizeInvokeError({ msg: 'from msg' }).message).toBe('from msg');
    expect(normalizeInvokeError({ error: 'from error' }).message).toBe('from error');
  });

  test('falls back to JSON for an object with no readable field', () => {
    expect(normalizeInvokeError({ code: 42 }).message).toBe('{"code":42}');
  });

  test('never yields an empty message for null or undefined', () => {
    expect(normalizeInvokeError(null).message).toBe('Unknown error');
    expect(normalizeInvokeError(undefined).message).toBe('Unknown error');
  });

  test('stringifies other primitives', () => {
    expect(normalizeInvokeError(404).message).toBe('404');
  });

  test('ignores an empty string field and keeps looking', () => {
    expect(normalizeInvokeError({ message: '', msg: 'second choice' }).message).toBe(
      'second choice',
    );
  });
});
