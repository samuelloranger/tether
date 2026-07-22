// Reconstructs tappable URLs across soft-wrapped grid rows.
//
// The terminal is a fixed-width grid: a URL longer than the width is autowrapped
// onto the next row, so per-row link detection would only ever see a truncated
// fragment. getSnapshot marks each row's `wrapped` flag (true = this row's
// logical line continues on the next row); here we group wrapped rows back into
// one logical line, find URLs in the joined text, and map each match back to
// per-row column spans that all carry the FULL url. Tapping any fragment then
// opens the whole link.

const URL_RE = /(https?:\/\/[^\s]+)/g;

// `[^\s]+` greedily swallows trailing punctuation that visually follows a URL
// but isn't part of it — a URL wrapped in parens like `(https://x/)` matches
// through the `)`, so tapping opens `https://x/)` (which servers 301 to `/)/`).
// Strip trailing sentence/bracket punctuation, but keep a `)` when the URL has a
// matching unclosed `(` (e.g. Wikipedia `..._(disambiguation)`).
function trimUrlEnd(url: string): string {
  while (url.length > 0) {
    const ch = url[url.length - 1];
    if (ch === ')') {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes <= opens) break; // balanced — the `)` belongs to the URL
    } else if (!'.,;:!?\'"]}>'.includes(ch)) {
      break;
    }
    url = url.slice(0, -1);
  }
  return url;
}
const FILE_RE =
  /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.[\w-]+(?::[1-9]\d*(?::[1-9]\d*)?)?)(?=$|\s|[)\],;.])/g;

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; line?: number; column?: number };

export interface LinkSpan {
  start: number; // inclusive column offset into the row's text
  end: number; // exclusive
  target: LinkTarget;
}

export function parseFileTarget(token: string): Extract<LinkTarget, { kind: 'file' }> | null {
  const clean = token.replace(/[)\],;.]+$/, '');
  const match = /^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?)?$/.exec(clean);
  if (!match || !match[1].includes('/') || !/\/[\w.-]+\.[\w-]+$/.test(match[1])) return null;
  if (match[1].startsWith('/') || match[1].split('/').includes('..')) return null;
  return {
    kind: 'file',
    path: match[1],
    ...(match[2] ? { line: Number(match[2]) } : {}),
    ...(match[3] ? { column: Number(match[3]) } : {}),
  };
}

// `texts[i]` is row i's plain text; `wrapped[i]` is true when row i soft-wraps
// into row i+1. Returns one LinkSpan[] per row (empty when the row has no link).
export function computeLinkSpans(texts: string[], wrapped: boolean[]): LinkSpan[][] {
  const out: LinkSpan[][] = texts.map(() => []);
  let i = 0;
  while (i < texts.length) {
    // Extend the group across every soft-wrap boundary.
    let j = i;
    while (wrapped[j] && j + 1 < texts.length) j++;

    // Cumulative start offset of each row within the joined logical line.
    const joined = texts.slice(i, j + 1).join('');
    const offs: number[] = [];
    let acc = 0;
    for (let k = i; k <= j; k++) {
      offs.push(acc);
      acc += texts[k].length;
    }

    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = URL_RE.exec(joined))) {
      const url = trimUrlEnd(m[0]);
      if (!url) continue;
      const s = m.index;
      const e = s + url.length;
      const target: LinkTarget = { kind: 'external', url };
      for (let k = i; k <= j; k++) {
        const rowStart = offs[k - i];
        const rowEnd = rowStart + texts[k].length;
        const a = Math.max(s, rowStart);
        const b = Math.min(e, rowEnd);
        if (a < b) out[k].push({ start: a - rowStart, end: b - rowStart, target });
      }
    }
    FILE_RE.lastIndex = 0;
    while ((m = FILE_RE.exec(joined))) {
      const raw = m[1];
      const target = parseFileTarget(raw);
      if (!target) continue;
      const s = m.index + m[0].indexOf(raw);
      const e = s + raw.length;
      for (let k = i; k <= j; k++) {
        const rowStart = offs[k - i];
        const rowEnd = rowStart + texts[k].length;
        const a = Math.max(s, rowStart);
        const b = Math.min(e, rowEnd);
        if (a < b) out[k].push({ start: a - rowStart, end: b - rowStart, target });
      }
    }

    i = j + 1;
  }
  return out;
}

export interface RunSegment {
  text: string;
  target?: LinkTarget;
}

// Splits one render run's text into maximal segments that share a single target
// (or none), given `urlAt` — a column→target lookup for the whole row — and the run's
// starting column `base`. Lets the renderer wrap only the link portion of a run
// in a tappable element while leaving surrounding text plain.
export function splitRunByLinks(
  text: string,
  base: number,
  urlAt: (LinkTarget | undefined)[],
): RunSegment[] {
  const segs: RunSegment[] = [];
  for (let p = 0; p < text.length; ) {
    const target = urlAt[base + p];
    let q = p + 1;
    while (q < text.length && urlAt[base + q] === target) q++;
    segs.push({ text: text.slice(p, q), target });
    p = q;
  }
  return segs;
}

// Expands per-row link spans into a column→target lookup for O(1) queries per cell.
export function urlColumns(links: LinkSpan[]): (LinkTarget | undefined)[] {
  const urlAt: (LinkTarget | undefined)[] = [];
  for (const s of links) {
    for (let c = s.start; c < s.end; c++) urlAt[c] = s.target;
  }
  return urlAt;
}
