import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { previewMime } from '@/http/previewMime';
import { canonicalPath, inside } from '@/workspace/file';

function isRelative(ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return false;
  // Leave absolute URLs (scheme:, //host), fragments, and host-absolute paths.
  return !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/|data:)/i.test(trimmed);
}

// Resolves a relative ref against `baseDir` but confines the result to `root`
// (the preview's own directory). Returns the canonical file path, or null when
// the ref escapes the root — lexically or through a symlink — or names a
// directory. A null means "leave the reference untouched, read nothing": the
// only files that ever get inlined are the ones below the preview root.
function resolveInside(root: string, baseDir: string, ref: string): string | null {
  const attempted = path.resolve(baseDir, ref);
  if (!inside(root, attempted)) return null;
  let candidate: string;
  try {
    candidate = canonicalPath(attempted);
    if (!inside(root, candidate)) return null;
    if (statSync(candidate).isDirectory()) return null;
  } catch {
    return null;
  }
  return candidate;
}

function dataUri(file: string): string {
  const bytes = readFileSync(file);
  return `data:${previewMime(file)};base64,${bytes.toString('base64')}`;
}

// Rewrites @import and url() inside a stylesheet, resolved relative to the
// stylesheet's own directory but confined to the preview root. @import pulls the
// target's text in place (recursing so its own imports/urls resolve against ITS
// directory); url() becomes a data: URI. `seen` breaks @import cycles.
function inlineCss(css: string, root: string, cssDir: string, seen: Set<string>): string {
  const withImports = css.replace(
    /@import\s+(?:url\(\s*)?(["']?)([^"')]+)\1\s*\)?\s*;/gi,
    (match, _quote, ref) => {
      if (!isRelative(ref)) return match;
      const target = resolveInside(root, cssDir, ref);
      if (!target || seen.has(target)) return match;
      return inlineCss(
        readFileSync(target, 'utf8'),
        root,
        path.dirname(target),
        new Set(seen).add(target),
      );
    },
  );
  return withImports.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _quote, ref) => {
    if (!isRelative(ref)) return match;
    const target = resolveInside(root, cssDir, ref);
    return target ? `url(${dataUri(target)})` : match;
  });
}

function inlineLinks(html: string, root: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    if (!href || !isRelative(href[2])) return tag;
    const file = resolveInside(root, root, href[2]);
    if (!file) return tag;
    if (/\brel\s*=\s*(["']?)stylesheet\1/i.test(tag)) {
      return `<style>${inlineCss(readFileSync(file, 'utf8'), root, path.dirname(file), new Set([file]))}</style>`;
    }
    // Other linked assets (icons, manifests, preloads) keep their tag; only the
    // href becomes self-contained.
    return tag.replace(/(\bhref\s*=\s*)(["'])(.*?)\2/i, `$1$2${dataUri(file)}$2`);
  });
}

function inlineScripts(html: string, root: string): string {
  return html.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (match, attrs: string) => {
    const src = attrs.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    if (!src || !isRelative(src[2])) return match;
    const file = resolveInside(root, root, src[2]);
    if (!file) return match;
    const rest = attrs
      .replace(/\bsrc\s*=\s*(["']).*?\1/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return `<script${rest ? ` ${rest}` : ''}>${readFileSync(file, 'utf8')}</script>`;
  });
}

function inlineImages(html: string, root: string): string {
  return html.replace(
    /(<(?:img|source)\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi,
    (match, pre, quote, ref) => {
      if (!isRelative(ref)) return match;
      const file = resolveInside(root, root, ref);
      return file ? `${pre}${quote}${dataUri(file)}${quote}` : match;
    },
  );
}

export function inlinePresentation(entry: string): string {
  const root = canonicalPath(path.dirname(entry));
  let html = readFileSync(entry, 'utf8');
  html = inlineLinks(html, root);
  html = inlineScripts(html, root);
  html = inlineImages(html, root);
  return html;
}
