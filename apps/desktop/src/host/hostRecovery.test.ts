import { describe, expect, test } from 'bun:test';
import { hostsBecomingReachable } from './hostRecovery';

describe('hostsBecomingReachable', () => {
  test('names a host that flipped unreachable -> reachable', () => {
    expect(hostsBecomingReachable({ a: 'unreachable' }, { a: 'reachable' })).toEqual(['a']);
  });

  test('names a host that flipped unknown -> reachable', () => {
    expect(hostsBecomingReachable({}, { a: 'reachable' })).toEqual(['a']);
  });

  test('ignores a host that was already reachable (edge, not level)', () => {
    expect(hostsBecomingReachable({ a: 'reachable' }, { a: 'reachable' })).toEqual([]);
  });

  test('ignores a host that went reachable -> unreachable', () => {
    expect(hostsBecomingReachable({ a: 'reachable' }, { a: 'unreachable' })).toEqual([]);
  });

  test('reports only the hosts that crossed the edge', () => {
    expect(
      hostsBecomingReachable(
        { a: 'reachable', b: 'unreachable', c: 'unknown' },
        { a: 'reachable', b: 'reachable', c: 'reachable' },
      ).sort(),
    ).toEqual(['b', 'c']);
  });

  test('re-reachable after a drop counts as a new edge', () => {
    expect(hostsBecomingReachable({ a: 'unreachable' }, { a: 'reachable' })).toEqual(['a']);
  });
});
