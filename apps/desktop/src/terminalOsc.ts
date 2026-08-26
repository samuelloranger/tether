import type { Terminal } from '@xterm/xterm';
import { coreOsc52Decode } from './coreApi';

export function registerOsc52Handler(
  term: Terminal,
  writeClipboard: (text: string) => void,
): { dispose: () => void } {
  const disposable = term.parser.registerOscHandler(52, (data) => {
    void coreOsc52Decode(data).then((text) => {
      if (text) writeClipboard(text);
    });
    return true;
  });
  return { dispose: () => disposable.dispose() };
}

export function observeMouseSgr(term: Terminal, setSgr: (enabled: boolean) => void): () => void {
  const on = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params.flat().includes(1006)) setSgr(true);
    return false;
  });
  const off = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.flat().includes(1006)) setSgr(false);
    return false;
  });
  return () => {
    on.dispose();
    off.dispose();
  };
}
