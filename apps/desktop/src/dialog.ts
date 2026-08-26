export type AlertRequest =
  | { kind: 'notify'; title: string; body: string; level: 'info' | 'error'; resolve: () => void }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      confirmLabel: string;
      destructive: boolean;
      resolve: (ok: boolean) => void;
    };

const queue: AlertRequest[] = [];
let listener: ((req: AlertRequest | null) => void) | null = null;

function showNext() {
  listener?.(queue[0] ?? null);
}

export function subscribeAlert(l: (req: AlertRequest | null) => void): () => void {
  listener = l;
  showNext();
  return () => {
    listener = null;
  };
}

function dequeueAndShowNext() {
  queue.shift();
  showNext();
}

export async function notify(
  title: string,
  body: string,
  kind: 'info' | 'error' = 'info',
): Promise<void> {
  return new Promise<void>((resolve) => {
    queue.push({
      kind: 'notify',
      title,
      body,
      level: kind,
      resolve: () => {
        dequeueAndShowNext();
        resolve();
      },
    });
    if (queue.length === 1) showNext();
  });
}

export async function confirmAction(
  title: string,
  body: string,
  opts: { confirmLabel?: string; destructive?: boolean } = {},
): Promise<boolean> {
  const { confirmLabel = 'OK', destructive = false } = opts;
  return new Promise<boolean>((resolve) => {
    queue.push({
      kind: 'confirm',
      title,
      body,
      confirmLabel,
      destructive,
      resolve: (ok) => {
        dequeueAndShowNext();
        resolve(ok);
      },
    });
    if (queue.length === 1) showNext();
  });
}
