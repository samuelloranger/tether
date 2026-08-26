import { describe, expect, it } from 'bun:test';
import { sessionLabel, sessionLabels } from './sessionLabel';

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
