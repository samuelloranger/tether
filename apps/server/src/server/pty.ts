import { addTerminalLog, upsertSession, getLogs } from './db';

interface SessionInstance {
  process: any;
  subscribers: Set<(data: { type: 'output' | 'exit'; chunk?: string; exitCode?: number; id?: number }) => void>;
}

const instances = new Map<string, SessionInstance>();
const decoder = new TextDecoder('utf-8');

export function startSession(
  id: string,
  command: string = 'bash',
  cols: number = 80,
  rows: number = 24
) {
  if (instances.has(id)) {
    return instances.get(id)!;
  }

  // Ensure session exists in DB
  upsertSession(id, command, 'running');

  // Spawn the child process using Bun's native PTY support
  // Note: we run the command inside a shell or directly. Spawning bash as default.
  const proc = Bun.spawn([command], {
    env: process.env,
    terminal: {
      cols,
      rows,
      data(terminal, uint8Array) {
        const text = decoder.decode(uint8Array);
        
        // Write to DB and capture insert row ID
        const logId = addTerminalLog(id, text);

        // Notify active subscribers
        const inst = instances.get(id);
        if (inst) {
          for (const sub of inst.subscribers) {
            try {
              sub({ type: 'output', chunk: text, id: logId });
            } catch (err) {
              console.error(`Error sending PTY output to session subscriber "${id}":`, err);
            }
          }
        }
      },
    },
  });

  const instance: SessionInstance = {
    process: proc,
    subscribers: new Set(),
  };

  instances.set(id, instance);

  // Handle termination
  proc.exited.then((code) => {
    console.log(`PTY process for session "${id}" exited with code ${code}`);
    upsertSession(id, command, 'stopped');

    const inst = instances.get(id);
    if (inst) {
      for (const sub of inst.subscribers) {
        try {
          sub({ type: 'exit', exitCode: code });
        } catch (err) {
          console.error(`Error sending PTY exit to session subscriber "${id}":`, err);
        }
      }
      inst.subscribers.clear();
    }
    instances.delete(id);
  });

  return instance;
}

export function writeToSession(id: string, text: string) {
  const instance = instances.get(id);
  if (instance && instance.process.terminal) {
    instance.process.terminal.write(text);
    return true;
  }
  return false;
}

export function resizeSession(id: string, cols: number, rows: number) {
  const instance = instances.get(id);
  if (instance && instance.process.terminal) {
    try {
      instance.process.terminal.resize(cols, rows);
      return true;
    } catch (e) {
      console.error(`Failed to resize terminal for session "${id}":`, e);
    }
  }
  return false;
}

export function subscribeToSession(
  id: string,
  callback: (data: { type: 'output' | 'exit'; chunk?: string; exitCode?: number }) => void
) {
  const instance = instances.get(id);
  if (instance) {
    instance.subscribers.add(callback);
    return () => {
      instance.subscribers.delete(callback);
    };
  }
  return () => {};
}

export function killSession(id: string) {
  const instance = instances.get(id);
  if (instance) {
    instance.process.kill();
    instances.delete(id);
    upsertSession(id, '', 'stopped');
    return true;
  }
  return false;
}

export function getActiveSession(id: string) {
  return instances.get(id);
}
