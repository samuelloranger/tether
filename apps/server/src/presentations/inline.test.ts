import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inlinePresentation } from './inline';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'inline-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, data: string | Buffer): string {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, data);
  return full;
}

test('inlines a relative <img> as a data: URI', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  write('logo.png', png);
  const entry = write('index.html', '<img src="./logo.png">');

  const html = inlinePresentation(entry);

  expect(html).toContain(`data:image/png;base64,${png.toString('base64')}`);
  expect(html).not.toContain('./logo.png');
});

test('inlines a stylesheet <link> into a <style> block', () => {
  write('app.css', 'body { color: red; }');
  const entry = write('index.html', '<link rel="stylesheet" href="app.css">');

  const html = inlinePresentation(entry);

  expect(html).toContain('<style>body { color: red; }</style>');
  expect(html).not.toContain('<link');
});

test('inlines a relative <script src> into an inline script', () => {
  write('app.js', 'console.log(1);');
  const entry = write('index.html', '<script src="./app.js"></script>');

  const html = inlinePresentation(entry);

  expect(html).toContain('<script>console.log(1);</script>');
  expect(html).not.toContain('src=');
});

test('resolves css url() relative to the stylesheet location', () => {
  const png = Buffer.from([1, 2, 3]);
  write('assets/bg.png', png);
  write('assets/app.css', 'body { background: url(bg.png); }');
  const entry = write('index.html', '<link rel="stylesheet" href="assets/app.css">');

  const html = inlinePresentation(entry);

  expect(html).toContain(`url(data:image/png;base64,${png.toString('base64')})`);
});

test('recursively inlines css @import', () => {
  write('base.css', 'p { margin: 0; }');
  write('app.css', '@import "base.css";\nspan { color: blue; }');
  const entry = write('index.html', '<link rel="stylesheet" href="app.css">');

  const html = inlinePresentation(entry);

  expect(html).toContain('p { margin: 0; }');
  expect(html).toContain('span { color: blue; }');
  expect(html).not.toContain('@import');
});

test('inlines a favicon <link rel="icon"> href as a data: URI', () => {
  const ico = Buffer.from([9, 9, 9]);
  write('fav.png', ico);
  const entry = write('index.html', '<link rel="icon" href="fav.png">');

  const html = inlinePresentation(entry);

  expect(html).toContain(`href="data:image/png;base64,${ico.toString('base64')}"`);
});

test('does not read or inline a ../ traversal outside the root', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'inline-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.png'), Buffer.from([9, 9, 9]));
    const rel = path.relative(root, path.join(outside, 'secret.png'));
    const entry = write('index.html', `<img src="${rel}">`);

    const html = inlinePresentation(entry);

    // The escaping ref is left verbatim, never read.
    expect(html).toContain(`<img src="${rel}">`);
    expect(html).not.toContain('data:image/png');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('does not follow a symlink that escapes the root', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'inline-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.css'), 'body{color:red}');
    symlinkSync(path.join(outside, 'secret.css'), path.join(root, 'link.css'));
    const entry = write('index.html', '<link rel="stylesheet" href="link.css">');

    const html = inlinePresentation(entry);

    expect(html).not.toContain('color:red');
    expect(html).toContain('link.css');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('does not inline a css url() that escapes the root', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'inline-outside-'));
  try {
    writeFileSync(path.join(outside, 'bg.png'), Buffer.from([1]));
    const rel = path.relative(root, path.join(outside, 'bg.png'));
    write('app.css', `body{background:url(${rel})}`);
    const entry = write('index.html', '<link rel="stylesheet" href="app.css">');

    const html = inlinePresentation(entry);

    expect(html).not.toContain('data:image/png');
    expect(html).toContain(`url(${rel})`);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('survives a circular @import without recursing forever', () => {
  write('a.css', '@import "b.css";\n.a{}');
  write('b.css', '@import "a.css";\n.b{}');
  const entry = write('index.html', '<link rel="stylesheet" href="a.css">');

  const html = inlinePresentation(entry);

  expect(html).toContain('.a{}');
  expect(html).toContain('.b{}');
});

test('leaves absolute and data: references untouched', () => {
  const entry = write(
    'index.html',
    '<script src="https://cdn.example/x.js"></script><img src="data:image/png;base64,AAAA">',
  );

  const html = inlinePresentation(entry);

  expect(html).toContain('https://cdn.example/x.js');
  expect(html).toContain('data:image/png;base64,AAAA');
});
