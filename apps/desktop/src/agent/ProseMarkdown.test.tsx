import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { ProseMarkdown } from './ProseMarkdown';

test('inline code span renders as agent-code-inline, not a block', () => {
  const html = renderToString(<ProseMarkdown text={'hello `testflight` world'} />);
  expect(html).toContain('agent-code-inline');
  expect(html).not.toContain('agent-code-block');
});

test('fenced block renders as agent-code-block', () => {
  const html = renderToString(<ProseMarkdown text={'```ts\nconst a = 1;\n```'} />);
  expect(html).toContain('agent-code-block');
});

test('multiline indented code stays a block', () => {
  const html = renderToString(<ProseMarkdown text={'```\nline one\nline two\n```'} />);
  expect(html).toContain('agent-code-block');
});
