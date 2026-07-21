import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { deleteSession, getAuthHash, setAuthHash, upsertSession } from './db';
import { clearLiveCwd, reportCwd } from './liveCwd';

const PASSWORD = 'test-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}` };
const ID = 'gitops-api';
let root: string;
let previousAuthHash: string | null;

function git(cmd: string) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' });
}

function post(route: string, body: unknown) {
  return app.request(`/api/sessions/${ID}/git/${route}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  previousAuthHash = getAuthHash();
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tether-gitops-api-')));
  git('init -q');
  git('config user.email test@example.com');
  git('config user.name test');
  writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git('add a.txt');
  git('commit -q -m initial');
  upsertSession(ID, 'bash', 'running');
  reportCwd(ID, root);
});

afterEach(() => {
  clearLiveCwd(ID);
  deleteSession(ID);
  setAuthHash(previousAuthHash);
  rmSync(root, { recursive: true, force: true });
});

test('stage, commit, log, and commit diff round-trip', async () => {
  writeFileSync(path.join(root, 'a.txt'), 'two\n');

  let res = await post('stage', { path: 'a.txt' });
  expect(res.status).toBe(200);

  res = await post('commit', { message: 'from the app' });
  expect(res.status).toBe(200);

  res = await app.request(`/api/sessions/${ID}/git/log`, { headers: AUTH });
  expect(res.status).toBe(200);
  const log = (await res.json()) as { sha: string; subject: string }[];
  expect(log[0].subject).toBe('from the app');

  res = await app.request(`/api/sessions/${ID}/git/commit/${log[0].sha}/diff`, { headers: AUTH });
  expect(res.status).toBe(200);
  const { diff } = (await res.json()) as { diff: string };
  expect(diff).toContain('+two');
});

test('unstage and discard', async () => {
  writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  await post('stage', { path: 'a.txt' });

  let res = await post('unstage', { path: 'a.txt' });
  expect(res.status).toBe(200);
  expect(git('diff --cached --numstat')).toBe('');

  res = await post('discard', { path: 'a.txt' });
  expect(res.status).toBe(200);
  expect(git('status --porcelain')).toBe('');
});

test('commit with nothing staged → 409 with git message', async () => {
  const res = await post('commit', { message: 'nope' });
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error.length).toBeGreaterThan(0);
});

test('stage-hunk stale index → 409', async () => {
  writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const res = await post('stage-hunk', { path: 'a.txt', hunkIndex: 9 });
  expect(res.status).toBe(409);
});

test('missing body fields → 400', async () => {
  expect((await post('stage', {})).status).toBe(400);
  expect((await post('commit', {})).status).toBe(400);
  expect((await post('stage-hunk', { path: 'a.txt' })).status).toBe(400);
});

test('unknown session → 404, unauthenticated → 401', async () => {
  const res = await app.request('/api/sessions/nope/git/log', { headers: AUTH });
  expect(res.status).toBe(404);
  const unauthed = await app.request(`/api/sessions/${ID}/git/log`);
  expect(unauthed.status).toBe(401);
});
