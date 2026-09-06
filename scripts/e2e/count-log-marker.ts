// Counts terminal_logs chunks containing a marker string, across all sessions.
// The E2E suite types `echo <marker>` into a session; the PTY echoes the command
// and its output, so a non-zero count proves the typed input reached the PTY and
// ran. Run with TETHER_DB_PATH pointing at the server's DB.
//
//   TETHER_DB_PATH=~/.tether-e2e/tether.db bun scripts/e2e/count-log-marker.ts AFTER_REOPEN
import { Database } from 'bun:sqlite';

const marker = process.argv[2];
if (!marker) {
  process.stderr.write('usage: count-log-marker.ts <marker>\n');
  process.exit(2);
}

const db = new Database(process.env.TETHER_DB_PATH ?? '', { readonly: true });
const row = db
  .query('SELECT COUNT(*) AS n FROM terminal_logs WHERE chunk LIKE $m')
  .get({ $m: `%${marker}%` }) as { n: number };
process.stdout.write(`${row.n}\n`);
