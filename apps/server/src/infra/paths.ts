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

// The daemon's control socket. Isolated for a source run exactly like the DB is:
// the path is a fixed name, and `prepareControlSocket` unlinks whatever sits
// there, so a shared default let `bun dev:server` silently unlink the installed
// daemon's socket and leave every `tether signal` from a hook failing with
// Bun's FailedToOpenSocket ("Was there a typo in the url or port?").
export const CONTROL_SOCK =
  process.env.TETHER_CONTROL_SOCK ??
  (COMPILED ? path.join(STATE_DIR, 'control.sock') : path.join(CONFIG_DIR, 'control.sock'));

// Pre-binary installs kept the DB (and holder sockets) inside the ~/.tether/app
// source copy. Migrated / adopted once on upgrade to the installed binary.
export const OLD_DB_PATH = path.join(STATE_DIR, 'app', 'config', 'tether.db');
export const OLD_HOLDERS_DIR = path.join(STATE_DIR, 'app', 'config', 'holders');
