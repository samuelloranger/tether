import type { SearchAddon } from '@xterm/addon-search';
import { useEffect, useRef, useState } from 'react';

export interface TerminalFindBarProps {
  search: SearchAddon | null;
  onClose: () => void;
}

export function isFindChord(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f';
}

export function TerminalFindBar({ search, onClose }: TerminalFindBarProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(-1);
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!search) return undefined;
    const disposable = search.onDidChangeResults((event) => {
      setIndex(event.resultIndex);
      setCount(event.resultCount);
    });
    return () => disposable.dispose();
  }, [search]);

  const decorations = {
    matchBackground: '#89b4fa55',
    activeMatchBackground: '#89b4fa',
    matchOverviewRuler: '#89b4fa',
    activeMatchColorOverviewRuler: '#89b4fa',
  };

  const findNext = () => {
    if (!search || !query) return;
    search.findNext(query, { decorations });
  };

  const findPrevious = () => {
    if (!search || !query) return;
    search.findPrevious(query, { decorations });
  };

  return (
    <div className="terminal-find-bar">
      <input
        ref={inputRef}
        value={query}
        placeholder="Find"
        onChange={(event) => {
          setQuery(event.target.value);
          if (!search) return;
          if (!event.target.value) {
            search.clearDecorations();
            setIndex(-1);
            setCount(0);
            return;
          }
          search.findNext(event.target.value, { incremental: true, decorations });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) findPrevious();
            else findNext();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            search?.clearDecorations();
            onClose();
          }
        }}
      />
      <span className="terminal-find-count">
        {count > 0 ? `${index + 1}/${count}` : query ? '0/0' : ''}
      </span>
      <button type="button" className="small secondary" onClick={() => findPrevious()}>
        Prev
      </button>
      <button type="button" className="small secondary" onClick={() => findNext()}>
        Next
      </button>
      <button type="button" className="small secondary" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
