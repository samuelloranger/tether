import { describe, expect, test } from 'bun:test';
import { AGENT_COMMANDS, dispatchDraft, matchCommands } from './agentCommands';

describe('matchCommands', () => {
  test('bare slash returns all commands', () => {
    expect(matchCommands('/')).toEqual(AGENT_COMMANDS);
  });
  test('filters by substring after the slash', () => {
    const ids = matchCommands('/co').map((c) => c.id);
    expect(ids).toContain('copy');
    expect(ids).toContain('compact');
    expect(ids).not.toContain('clear');
  });
  test('a space closes the palette (no matches)', () => {
    expect(matchCommands('/model sonnet')).toEqual([]);
  });
  test('non-slash draft never matches', () => {
    expect(matchCommands('hello')).toEqual([]);
  });
});

describe('dispatchDraft', () => {
  test('known local command → local action with args', () => {
    expect(dispatchDraft('/copy all')).toEqual({ type: 'local', id: 'copy', args: 'all' });
  });
  test('known agent command → forwarded text verbatim', () => {
    expect(dispatchDraft('/compact')).toEqual({ type: 'agentText', text: '/compact' });
  });
  test('unknown slash command → forwarded verbatim (passthrough)', () => {
    expect(dispatchDraft('/wibble x')).toEqual({ type: 'agentText', text: '/wibble x' });
  });
  test('plain text → none', () => {
    expect(dispatchDraft('hello there')).toEqual({ type: 'none' });
  });
});
