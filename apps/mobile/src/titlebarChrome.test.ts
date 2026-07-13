import { describe, expect, it } from 'bun:test';
import { MAC_TRAFFIC_LIGHT_INSET, titlebarChrome } from './titlebarChrome';

describe('titlebarChrome', () => {
  it('macOS: no custom controls, reserves traffic-light inset', () => {
    expect(titlebarChrome(true)).toEqual({ showControls: false, leftInset: MAC_TRAFFIC_LIGHT_INSET });
  });
  it('macOS fullscreen: inset collapses to 0 (traffic lights hidden)', () => {
    expect(titlebarChrome(true, true)).toEqual({ showControls: false, leftInset: 0 });
  });
  it('Windows/Linux: custom controls, no inset', () => {
    expect(titlebarChrome(false)).toEqual({ showControls: true, leftInset: 0 });
  });
  it('inset is a positive number', () => {
    expect(MAC_TRAFFIC_LIGHT_INSET).toBeGreaterThan(0);
  });
});
