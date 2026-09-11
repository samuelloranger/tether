import { describe, expect, test } from 'bun:test';
import { paneShortcutAction } from './useViewState';

type Key = Parameters<typeof paneShortcutAction>[0];

const key = (over: Partial<Key>): Key => ({
  key: 'a',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...over,
});

describe('paneShortcutAction — what the app claims', () => {
  test('Cmd+D splits into a row', () => {
    expect(paneShortcutAction(key({ key: 'd', metaKey: true }))).toBe('split-row');
  });

  test('Cmd+E splits into a column', () => {
    expect(paneShortcutAction(key({ key: 'e', metaKey: true }))).toBe('split-col');
  });

  test('Cmd+W closes the pane', () => {
    expect(paneShortcutAction(key({ key: 'w', metaKey: true }))).toBe('close');
  });

  test('Ctrl+Shift is the non-mac equivalent of Cmd', () => {
    expect(paneShortcutAction(key({ key: 'd', ctrlKey: true, shiftKey: true }))).toBe('split-row');
    expect(paneShortcutAction(key({ key: 'e', ctrlKey: true, shiftKey: true }))).toBe('split-col');
    expect(paneShortcutAction(key({ key: 'w', ctrlKey: true, shiftKey: true }))).toBe('close');
  });

  test('an uppercase key still matches (Shift is part of the gate)', () => {
    expect(paneShortcutAction(key({ key: 'D', ctrlKey: true, shiftKey: true }))).toBe('split-row');
  });
});

describe('paneShortcutAction — what must reach the PTY', () => {
  // The whole reason the gate is Cmd-or-Ctrl+Shift. If plain Ctrl+D were
  // captured, it would split a pane instead of sending EOF, and the user could
  // no longer exit a shell.
  test('plain Ctrl+D is NOT captured — it is the terminal EOF', () => {
    expect(paneShortcutAction(key({ key: 'd', ctrlKey: true }))).toBeNull();
  });

  test('plain Ctrl+E and Ctrl+W are not captured either', () => {
    expect(paneShortcutAction(key({ key: 'e', ctrlKey: true }))).toBeNull();
    expect(paneShortcutAction(key({ key: 'w', ctrlKey: true }))).toBeNull();
  });

  test('a bare keypress is not captured', () => {
    expect(paneShortcutAction(key({ key: 'd' }))).toBeNull();
  });

  test('Shift alone does not arm the gate', () => {
    expect(paneShortcutAction(key({ key: 'd', shiftKey: true }))).toBeNull();
  });

  test('a modified key outside d/e/w falls through', () => {
    expect(paneShortcutAction(key({ key: 'c', metaKey: true }))).toBeNull();
    expect(paneShortcutAction(key({ key: 'v', metaKey: true }))).toBeNull();
  });
});
