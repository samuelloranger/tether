import { describe, expect, it } from 'bun:test';
import { sessionLabel, sessionLabels, tabLabels } from './sessionLabel';

describe('sessionLabel', () => {
  it('prefers a user name, then the auto title, then the id', () => {
    expect(sessionLabel({ id: 'a', name: 'mine', auto_title: 'auto' })).toBe('mine');
    expect(sessionLabel({ id: 'a', name: null, auto_title: 'auto' })).toBe('auto');
    expect(sessionLabel({ id: 'a', name: null, auto_title: null })).toBe('a');
  });
});

describe('sessionLabels', () => {
  it('leaves a unique label alone', () => {
    const labels = sessionLabels([
      { id: 'one', auto_title: 'tether' },
      { id: 'two', auto_title: 'vigie' },
    ]);
    expect(labels.get('one')).toBe('tether');
    expect(labels.get('two')).toBe('vigie');
  });

  /// Three sessions in one repo all auto-title to the directory name, which made
  /// the drawer a list of identical rows.
  it('breaks a collision with the session id', () => {
    const labels = sessionLabels([
      { id: 'main', auto_title: 'tether' },
      { id: 'build', auto_title: 'tether' },
      { id: 'alone', auto_title: 'vigie' },
    ]);
    expect(labels.get('main')).toBe('tether · main');
    expect(labels.get('build')).toBe('tether · build');
    expect(labels.get('alone')).toBe('vigie');
  });

  /// A name the user typed is theirs; only the colliding ones get decorated.
  it('does not decorate a name that is already unique', () => {
    const labels = sessionLabels([
      { id: 'a', name: 'deploy', auto_title: 'tether' },
      { id: 'b', auto_title: 'tether' },
    ]);
    expect(labels.get('a')).toBe('deploy');
    expect(labels.get('b')).toBe('tether');
  });
});

describe('tabLabels', () => {
  const hosts = [
    { id: 'devbox', name: 'devbox' },
    { id: 'macbuild', name: 'macbuild' },
  ];

  it('leaves a unique label alone', () => {
    const labels = tabLabels(
      [
        { hostId: 'devbox', id: 'term-1', auto_title: 'tether' },
        { hostId: 'macbuild', id: 'term-1', auto_title: 'vigie' },
      ],
      hosts,
    );
    expect(labels.get('devbox:term-1')).toBe('tether');
    expect(labels.get('macbuild:term-1')).toBe('vigie');
  });

  it('appends the host name when the same label appears on two hosts', () => {
    const labels = tabLabels(
      [
        { hostId: 'devbox', id: 'term-1', auto_title: 'tether' },
        { hostId: 'macbuild', id: 'term-1', auto_title: 'tether' },
      ],
      hosts,
    );
    expect(labels.get('devbox:term-1')).toBe('tether · devbox');
    expect(labels.get('macbuild:term-1')).toBe('tether · macbuild');
  });

  it('still breaks a within-host collision with the session id first', () => {
    const labels = tabLabels(
      [
        { hostId: 'devbox', id: 'main', auto_title: 'tether' },
        { hostId: 'devbox', id: 'build', auto_title: 'tether' },
        { hostId: 'macbuild', id: 'term-1', auto_title: 'vigie' },
      ],
      hosts,
    );
    expect(labels.get('devbox:main')).toBe('tether · main');
    expect(labels.get('devbox:build')).toBe('tether · build');
    expect(labels.get('macbuild:term-1')).toBe('vigie');
  });
});
