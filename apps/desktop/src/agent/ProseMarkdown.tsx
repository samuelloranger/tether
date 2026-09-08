import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightLine } from '../git/codeHighlight';

/** A fenced code block, syntax-highlit through the shared tokenizer. */
function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <pre className="agent-code-block">
      <code>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <div key={i} className="agent-code-line">
            {highlightLine(line, language).map((tok, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
              <span key={j} className={tok.className}>
                {tok.text}
              </span>
            ))}
          </div>
        ))}
      </code>
    </pre>
  );
}

type CodeProps = ComponentPropsWithoutRef<'code'> & { inline?: boolean };

function renderCode({ inline, className, children }: CodeProps) {
  const text = String(children ?? '');
  if (inline) return <code className="agent-code-inline">{text}</code>;
  const match = /language-(\w+)/.exec(className ?? '');
  return <CodeBlock language={match ? match[1] : null} code={text} />;
}

/** Renders assistant markdown (GFM: tables, lists, headings, inline) with code
 * fences routed to the shared highlighter. */
export function ProseMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: renderCode as never }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
