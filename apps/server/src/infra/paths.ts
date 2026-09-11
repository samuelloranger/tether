import { homedir } from 'node:os';
import path from 'node:path';
import { COMPILED } from './runtime';

// All persistent daemon state lives under ~/.tether.
export const STATE_DIR = path.join(homedir(), '.tether');
export const PID_FILE = path.join(STATE_DIR, 'server.pid');
export const LOG_FILE = path.join(STATE_DIR, 'server.log');
export const UPLOADS_DIR = path.join(STATE_DIR, 'uploads');

// Where the SQLite DB lives, and thus the config dir (bashrc + holder sockets):
//   - TETHER_DB_PATH set  → exactly that (tests, custom deploys)
//   - installed binary    → ~/.tether/config/tether.db
//   - source / dev run     → repo-local apps/server/config/tether.db, so `bun
//     dev:server` on a host with an install never touches the live DB.
export const USING_DEFAULT_DB = !process.env.TETHER_DB_PATH;
export const DB_PATH =
  process.env.TETHER_DB_PATH ??
  (COMPILED
    ? path.join(STATE_DIR, 'config', 'tether.db')
    : path.join(process.cwd(), 'config', 'tether.db'));
export const CONFIG_DIR = path.dirname(DB_PATH);

// The daemon's control socket. It follows CONFIG_DIR for the same reason the
// holder sockets do: the path is a fixed name and `prepareControlSocket` now
// refuses to start when something is already serving it, so anything sharing
// the default is not merely racy but fatal to whichever daemon loses.
//
// Only the installed binary on its own default DB gets ~/.tether/control.sock.
// A source run isolates to the repo config dir, and — the case the e2e suite
// depends on — so does any run with TETHER_DB_PATH set, which is what lets
// several test servers exist at once. That matches the contract stated in
// crates/tether-core/tests/support/mod.rs: TETHER_DB_PATH relocates the config
// dir, and the sockets live in the config dir.
export const CONTROL_SOCK =
  process.env.TETHER_CONTROL_SOCK ??
  (COMPILED && USING_DEFAULT_DB
    ? path.join(STATE_DIR, 'control.sock')
    : path.join(CONFIG_DIR, 'control.sock'));

// Pre-binary installs kept the DB (and holder sockets) inside the ~/.tether/app
// source copy. Migrated / adopted once on upgrade to the installed binary.
export const OLD_DB_PATH = path.join(STATE_DIR, 'app', 'config', 'tether.db');
export const OLD_HOLDERS_DIR = path.join(STATE_DIR, 'app', 'config', 'holders');
