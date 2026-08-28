// Reproduce the daemon's situation: a console-less (detached) parent that
// spawns git, with and without windowsHide, counting conhost.exe each time.
import { spawnSync } from 'node:child_process';

function conhosts(): number {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    '(Get-Process conhost -ErrorAction SilentlyContinue).Count'],
    { encoding: 'utf8', windowsHide: true });
  return Number(out.stdout.trim()) || 0;
}

const mode = process.argv[2];
const before = conhosts();
for (let i = 0; i < 5; i++) {
  spawnSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    ...(mode === 'hide' ? { windowsHide: true } : {}),
  });
}
const after = conhosts();
console.log(`${mode}: conhost ${before} -> ${after} (peak delta observed during 5 git spawns)`);
