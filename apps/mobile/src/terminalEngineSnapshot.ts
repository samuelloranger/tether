import type { IBuffer } from '@xterm/headless';
import { computeLinkSpans, type LinkSpan } from './links';
import type { RenderRow } from './terminal';
import { linksEqual, runsEqual } from './terminalEngineStyle';

export function buildEngineSnapshot(args: {
  buf: IBuffer;
  cursorVisible: boolean;
  trimmed: number;
  promptIds: Set<number>;
  osc8Spans: Map<number, unknown>;
  osc8Has: (id: number) => boolean;
  freshOsc8: (id: number) => LinkSpan[];
  prevRows: RenderRow[];
  runsFor: (
    line: NonNullable<ReturnType<IBuffer['getLine']>>,
    caretCol: number,
  ) => RenderRow['runs'];
}): RenderRow[] {
  const { buf } = args;
  const total = buf.length;
  const cursorAbs = buf.baseY + buf.cursorY;
  if (args.promptIds.size) {
    for (const id of args.promptIds) if (id < args.trimmed) args.promptIds.delete(id);
  }
  if (args.osc8Spans.size) {
    for (const id of args.osc8Spans.keys()) if (id < args.trimmed) args.osc8Spans.delete(id);
  }

  const rowRuns: RenderRow['runs'][] = new Array(total);
  const wrappedFlags: boolean[] = new Array(total);
  const texts: string[] = new Array(total);
  for (let y = 0; y < total; y++) {
    const line = buf.getLine(y);
    if (!line) {
      rowRuns[y] = [{ text: '', style: {} }];
      wrappedFlags[y] = false;
      texts[y] = '';
      continue;
    }
    const caretCol = args.cursorVisible && y === cursorAbs ? buf.cursorX : -1;
    rowRuns[y] = args.runsFor(line, caretCol);
    // xterm's `isWrapped` means "this row is a CONTINUATION of the previous
    // one"; computeLinkSpans wants "this row wraps INTO the next", so read the
    // flag off the following line.
    wrappedFlags[y] = buf.getLine(y + 1)?.isWrapped ?? false;
    texts[y] = rowRuns[y].map((r) => r.text).join('');
  }
  const linkSpans = computeLinkSpans(texts, wrappedFlags);
  const out: RenderRow[] = new Array(total);
  for (let y = 0; y < total; y++) {
    const key = args.trimmed + y;
    const runs = rowRuns[y];
    const wrapped = wrappedFlags[y];
    const osc8 = args.osc8Has(key) ? args.freshOsc8(key) : [];
    const links = osc8.length ? osc8 : (linkSpans[y] ?? []);
    const promptStart = args.promptIds.has(key);
    const prev = args.prevRows[y];
    out[y] =
      prev &&
      prev.key === key &&
      prev.wrapped === wrapped &&
      prev.promptStart === promptStart &&
      runsEqual(prev.runs, runs) &&
      linksEqual(prev.links, links)
        ? prev
        : { key, runs, wrapped, links, promptStart };
  }
  return out;
}
