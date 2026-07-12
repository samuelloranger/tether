import { homedir } from 'node:os';
import path from 'node:path';

// All persistent tether state lives under ~/.tether.
export const STATE_DIR = path.join(homedir(), '.tether');
export const PID_FILE = path.join(STATE_DIR, 'server.pid');
export const LOG_FILE = path.join(STATE_DIR, 'server.log');

// Config dir holds the DB, generated bashrc, and per-session holder sockets.
export const CONFIG_DIR = path.join(STATE_DIR, 'config');
// DB default moved out of the old source-copy dir into ~/.tether/config.
export const DEFAULT_DB_PATH = path.join(CONFIG_DIR, 'tether.db');
// Pre-binary installs kept the DB inside the ~/.tether/app source copy.
export const OLD_DB_PATH = path.join(STATE_DIR, 'app', 'config', 'tether.db');
// ...and the holder sockets alongside it. Scanned once on upgrade so live PTY
// sessions from the old server reattach.
export const OLD_HOLDERS_DIR = path.join(STATE_DIR, 'app', 'config', 'holders');
