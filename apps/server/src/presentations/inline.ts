import { readFileSync } from 'node:fs';
import path from 'node:path';
import { previewMime } from '@/http/previewMime';

function isRelative(ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return false;
  // Leave absolute URLs (scheme:, //host), fragments, and host-absolute paths.
  return !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/|data:)/i.test(trimmed);
}

function dataUri(file: string): string {
  const bytes = readFileSync(file);
  return `data:${previewMime(file)};base64,${bytes.toString('base64')}`;
}

// Rewrites @import and url() inside a stylesheet, resolved relative to the
// stylesheet's own directory. @import pulls the target's text in place (recursing
// so its own imports/urls resolve against ITS directory); url() becomes a data: URI.
function inlineCss(css: string, cssDir: string): string {
  const withImports = css.replace(
    /@import\s+(?:url\(\s*)?(["']?)([^"')]+)\1\s*\)?\s*;/gi,
    (match, _quote, ref) => {
      if (!isRelative(ref)) return match;
      const target = path.resolve(cssDir, ref);
      return inlineCss(readFileSync(target, 'utf8'), path.dirname(target));
    },
  );
  return withImports.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _quote, ref) => {
    if (!isRelative(ref)) return match;
    return `url(${dataUri(path.resolve(cssDir, ref))})`;
  });
}

function inlineLinks(html: string, root: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    if (!href || !isRelative(href[2])) return tag;
    const file = path.resolve(root, href[2]);
    if (/\brel\s*=\s*(["']?)stylesheet\1/i.test(tag)) {
      return `<style>${inlineCss(readFileSync(file, 'utf8'), path.dirname(file))}</style>`;
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
    const file = path.resolve(root, src[2]);
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
      return `${pre}${quote}${dataUri(path.resolve(root, ref))}${quote}`;
    },
  );
}

export function inlinePresentation(entry: string): string {
  const root = path.dirname(entry);
  let html = readFileSync(entry, 'utf8');
  html = inlineLinks(html, root);
  html = inlineScripts(html, root);
  html = inlineImages(html, root);
  return html;
}
