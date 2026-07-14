import React from 'react';
import { View, Text, Linking, StyleSheet, type TextStyle } from 'react-native';
import type { RenderRow, CellStyle } from './terminal';
import { splitRunByLinks, urlColumns } from './links';
import { isDesktop } from './platform';

function runToStyle(
  s: CellStyle,
  caretOn: boolean,
  cursorStyle: 'block' | 'bar' | 'underline',
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
      style.borderLeftColor = '#818cf8';
    } else if (cursorStyle === 'underline') {
      style.textDecorationLine = 'underline';
      style.textDecorationColor = '#818cf8';
    } else {
      // Block caret: accent background, dark glyph for contrast.
      style.backgroundColor = '#818cf8';
      style.color = '#0b0f19';
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
  }: {
    row: RenderRow;
    fontSize: number;
    lineHeight: number;
    width: number;
    blinkOn: boolean;
    cursorStyle: 'block' | 'bar' | 'underline';
    fontFamily: string;
  }) {
    // Column → full URL, from spans the emulator resolved across soft-wrapped
    // rows. A wrapped link's fragments each carry the WHOLE url, so tapping any
    // fragment (on either row) opens the complete link.
    const urlAt = urlColumns(row.links);

    let col = 0;
    return (
      <View style={{ height: lineHeight, width, overflow: 'hidden' }}>
        <Text
          style={[
            styles.termLine,
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
            const st = runToStyle(run.style, blinkOn, cursorStyle);
            const segs = splitRunByLinks(run.text, col, urlAt);
            col += run.text.length;
            return segs.map((seg, j) =>
              seg.url ? (
                <Text
                  key={`${i}-${j}`}
                  style={[st, styles.link]}
                  onPress={() => Linking.openURL(seg.url!)}
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
    // Blink only invalidates the row that actually contains the caret.
    (prev.blinkOn === next.blinkOn || !rowHasCaret(next.row)),
);

const styles = StyleSheet.create({
  termLine: {
    color: '#cbd5e1',
  },
  link: {
    textDecorationLine: 'underline',
  },
});
