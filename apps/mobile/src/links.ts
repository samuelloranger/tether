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

export interface LinkSpan {
  start: number; // inclusive column offset into the row's text
  end: number; // exclusive
  url: string; // full reconstructed URL
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
      const s = m.index;
      const e = s + m[0].length;
      const url = m[0];
      for (let k = i; k <= j; k++) {
        const rowStart = offs[k - i];
        const rowEnd = rowStart + texts[k].length;
        const a = Math.max(s, rowStart);
        const b = Math.min(e, rowEnd);
        if (a < b) out[k].push({ start: a - rowStart, end: b - rowStart, url });
      }
    }

    i = j + 1;
  }
  return out;
}

export interface RunSegment {
  text: string;
  url?: string; // set when this segment is (part of) a link
}

// Splits one render run's text into maximal segments that share a single URL (or
// none), given `urlAt` — a column→url lookup for the whole row — and the run's
// starting column `base`. Lets the renderer wrap only the link portion of a run
// in a tappable element while leaving surrounding text plain.
export function splitRunByLinks(
  text: string,
  base: number,
  urlAt: (string | undefined)[],
): RunSegment[] {
  const segs: RunSegment[] = [];
  for (let p = 0; p < text.length; ) {
    const url = urlAt[base + p];
    let q = p + 1;
    while (q < text.length && urlAt[base + q] === url) q++;
    segs.push({ text: text.slice(p, q), url });
    p = q;
  }
  return segs;
}

// Expands per-row link spans into a column→url lookup for O(1) queries per cell.
export function urlColumns(links: LinkSpan[]): (string | undefined)[] {
  const urlAt: (string | undefined)[] = [];
  for (const s of links) for (let c = s.start; c < s.end; c++) urlAt[c] = s.url;
  return urlAt;
}
