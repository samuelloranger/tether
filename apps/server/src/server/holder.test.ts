import { describe, expect, test } from 'bun:test';
import { isInterruptKeystroke } from './holder';

const ETX = 0x03;

describe('isInterruptKeystroke', () => {
  test('true for a lone Ctrl+C byte', () => {
    expect(isInterruptKeystroke(new Uint8Array([ETX]))).toBe(true);
  });

  test('false for an empty chunk', () => {
    expect(isInterruptKeystroke(new Uint8Array([]))).toBe(false);
  });

  test('false for ordinary input', () => {
    expect(isInterruptKeystroke(new TextEncoder().encode('ls -la\n'))).toBe(false);
  });

  test('false for a paste that happens to carry a 0x03 byte', () => {
    // The regression: a multi-byte buffer containing ETX must not read as an
    // interrupt, or a paste would taskkill the foreground job.
    expect(isInterruptKeystroke(new Uint8Array([0x61, ETX, 0x62]))).toBe(false);
    expect(isInterruptKeystroke(new Uint8Array([ETX, ETX]))).toBe(false);
  });
});
