import React, { useRef } from 'react';
import { type GestureResponderEvent, StyleSheet, Text, type TextStyle, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { type LinkTarget, splitRunByLinks, urlColumns } from './links';
import { isDesktop } from './platform';
import type { CellStyle, RenderRow } from './terminal';
import { wordAtColumn } from './wordAt';

function runToStyle(
  s: CellStyle,
  caretOn: boolean,
  cursorStyle: 'block' | 'bar' | 'underline',
  accent: string,
  accentText: string,
): TextStyle {
  const style: TextStyle = {};
  if (s.fg) style.color = s.fg;
  if (s.bg) style.backgroundColor = s.bg;
  if (s.bold) style.fontWeight = 'bold';
  if (s.dim) style.opacity = 0.55;
  if (s.italic) style.fontStyle = 'italic';
  if (s.underline && s.strike) style.textDecorationLine = 'underline line-through';
  else if (s.underline) style.textDecorationLine = 'underline';
  else if (s.strike) style.textDecorationLine = 'line-through';
  if (s.caret && caretOn) {
    if (cursorStyle === 'bar') {
      style.borderLeftWidth = 2;
      style.borderLeftColor = accent;
    } else if (cursorStyle === 'underline') {
      style.textDecorationLine = 'underline';
      style.textDecorationColor = accent;
    } else {
      // Block caret: accent background, dark glyph for contrast.
      style.backgroundColor = accent;
      style.color = accentText;
    }
  }
  return style;
}

// Memoized terminal row. Props are shallow-compared; the emulator reuses the
// same `row` object for unchanged lines, so continuous TUI repaints only
// re-render the handful of rows that actually changed.
const rowHasCaret = (row: RenderRow) => row.runs.some((r) => r.style.caret);

export const TermRow = React.memo(
  function TermRow({
    row,
    fontSize,
    lineHeight,
    width,
    blinkOn,
    cursorStyle,
    fontFamily,
    onOpenLink,
    charWidth,
    onCopyWord,
  }: {
    row: RenderRow;
    fontSize: number;
    lineHeight: number;
    width: number;
    blinkOn: boolean;
    cursorStyle: 'block' | 'bar' | 'underline';
    fontFamily: string;
    onOpenLink: (target: LinkTarget) => void;
    // Monospace advance width, for mapping a tap's x-offset to a column.
    charWidth?: number;
    // Mobile: double-tap a word to copy it. Undefined on desktop (native selection).
    onCopyWord?: (word: string) => void;
  }) {
    const { theme } = useAppTheme();
    // Double-tap-to-copy (mobile). Plain touch handlers on the row View — not
    // a Pressable — so the grid's tap-to-focus Pressable and FlatList scroll
    // gestures keep working exactly as before; we only watch for two quick,
    // low-travel touches and read the second one's column.
    const touchStart = useRef({ x: 0, y: 0, t: 0 });
    const lastTapAt = useRef(0);
    const onTouchStart = (e: GestureResponderEvent) => {
      touchStart.current = {
        x: e.nativeEvent.locationX,
        y: e.nativeEvent.locationY,
        t: Date.now(),
      };
    };
    const onTouchEnd = (e: GestureResponderEvent) => {
      if (!onCopyWord || !charWidth) return;
      const { x, y, t } = touchStart.current;
      const now = Date.now();
      const moved =
        Math.abs(e.nativeEvent.locationX - x) > 10 || Math.abs(e.nativeEvent.locationY - y) > 10;
      if (moved || now - t > 250) return; // a scroll/press, not a tap
      if (now - lastTapAt.current < 300) {
        lastTapAt.current = 0;
        const text = row.runs.map((r) => r.text).join('');
        const word = wordAtColumn(text, Math.floor(e.nativeEvent.locationX / charWidth));
        if (word) onCopyWord(word);
      } else {
        lastTapAt.current = now;
      }
    };
    // Column → full URL, from spans the emulator resolved across soft-wrapped
    // rows. A wrapped link's fragments each carry the WHOLE url, so tapping any
    // fragment (on either row) opens the complete link.
    const urlAt = urlColumns(row.links);

    let col = 0;
    return (
      <View
        style={{ height: lineHeight, width, overflow: 'hidden' }}
        onTouchStart={onCopyWord ? onTouchStart : undefined}
        onTouchEnd={onCopyWord ? onTouchEnd : undefined}
      >
        <Text
          style={[
            [styles.termLine, { color: theme.terminal.fg }],
            { fontFamily, fontSize, lineHeight, width },
            // Web: preserve whitespace. RN-web's numberOfLines=1 sets
            // white-space:nowrap, which collapses/trims spaces — that hides the
            // block caret (a trailing space) and breaks column alignment. `pre`
            // keeps every space on one line; the wrapper's overflow:hidden clips.
            isDesktop && ({ whiteSpace: 'pre' } as any),
          ]}
          numberOfLines={1}
          selectable={isDesktop}
        >
          {row.runs.map((run, i) => {
            const st = runToStyle(
              run.style,
              blinkOn,
              cursorStyle,
              theme.colors.accent,
              theme.colors.accentText,
            );
            const segs = splitRunByLinks(run.text, col, urlAt);
            col += run.text.length;
            return segs.map((seg, j) =>
              seg.target ? (
                <Text
                  key={`${i}-${j}`}
                  style={[st, styles.link]}
                  onPress={(e) => {
                    if (isDesktop) {
                      const mods = e.nativeEvent as unknown as {
                        ctrlKey?: boolean;
                        metaKey?: boolean;
                      };
                      if (!mods.ctrlKey && !mods.metaKey) return;
                    }
                    onOpenLink(seg.target!);
                  }}
                >
                  {seg.text}
                </Text>
              ) : (
                <Text key={`${i}-${j}`} style={st}>
                  {seg.text}
                </Text>
              ),
            );
          })}
        </Text>
      </View>
    );
  },
  (prev, next) =>
    prev.row === next.row &&
    prev.fontSize === next.fontSize &&
    prev.lineHeight === next.lineHeight &&
    prev.width === next.width &&
    prev.fontFamily === next.fontFamily &&
    prev.cursorStyle === next.cursorStyle &&
    prev.onOpenLink === next.onOpenLink &&
    prev.charWidth === next.charWidth &&
    prev.onCopyWord === next.onCopyWord &&
    // Blink only invalidates the row that actually contains the caret.
    (prev.blinkOn === next.blinkOn || !rowHasCaret(next.row)),
);

const styles = StyleSheet.create({
  // includeFontPadding: Android adds ascender/descender padding by default,
  // which shifts glyphs inside the fixed-lineHeight row and opens hairline
  // seams between rows with background colors (TUI panels). Same setting as
  // DiffLines/FileViewer.
  termLine: { includeFontPadding: false },
  link: {
    textDecorationLine: 'underline',
  },
});
