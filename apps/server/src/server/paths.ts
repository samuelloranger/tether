import { homedir } from 'node:os';
import path from 'node:path';

// All persistent tether state lives under ~/.tether.
export const STATE_DIR = path.join(homedir(), '.tether');
export const PID_FILE = path.join(STATE_DIR, 'server.pid');
export const LOG_FILE = path.join(STATE_DIR, 'server.log');

// DB default moved out of the old source-copy dir into ~/.tether/config.
export const DEFAULT_DB_PATH = path.join(STATE_DIR, 'config', 'tether.db');
// Pre-binary installs kept the DB inside the ~/.tether/app source copy.
export const OLD_DB_PATH = path.join(STATE_DIR, 'app', 'config', 'tether.db');
