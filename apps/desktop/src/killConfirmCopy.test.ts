import { describe, expect, test } from 'bun:test';
import { killConfirmCopy } from './killConfirmCopy';

describe('killConfirmCopy', () => {
  test('solo kill copy is unchanged', () => {
    expect(killConfirmCopy(['alpha'])).toEqual({
      title: 'Kill this terminal?',
      body: '“alpha” — the process and saved output will be deleted.',
    });
  });

  test('group kill lists every member', () => {
    expect(killConfirmCopy(['one', 'two'])).toEqual({
      title: 'Kill 2 terminals in this group?',
      body: 'one\ntwo',
    });
  });
});
