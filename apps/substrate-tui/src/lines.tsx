/** A column of toned or styled text lines, shared by the panels that render one (surgery, `/keys`). */

import { truncateCells } from '@mnmal-ai/surface-kit';
import type { Theme, Tone } from '@mnmal-ai/surface-theme';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { clean } from './text.js';

/** A run of text with its own styling, in theme tones. The text is rendered as given. */
export interface Part {
  readonly text: string;
  readonly tone?: Tone;
  readonly bg?: Tone;
  readonly bold?: boolean;
  readonly strike?: boolean;
}

/** One line, toned or made of styled parts. The text is rendered as given: callers sanitise. */
export interface Line {
  /** For a parts line, the parts' texts joined. */
  readonly text: string;
  readonly tone?: 'ok' | 'error' | 'warn' | 'dim';
  /** When set, `linesView` renders these and ignores `text` and `tone`. */
  readonly parts?: readonly Part[];
}

/** A line of styled parts, each sanitised onto one line (idempotent), whoever built it. */
export function partsLine(parts: readonly Part[]): Line {
  const safe = parts.map((p) => ({ ...p, text: clean(p.text) }));
  return { text: safe.map((p) => p.text).join(''), parts: safe };
}

/** Cut parts to `max` cells with a trailing `…`, keeping each kept part's styling. */
export function truncateParts(parts: readonly Part[], max: number): Part[] {
  const joined = parts.map((p) => p.text).join('');
  const cut = truncateCells(joined, max);
  if (cut === joined) return [...parts];
  // `cut` is a prefix of `joined` plus the ellipsis: keep that many characters of the parts.
  let left = cut.length - 1;
  const out: Part[] = [];
  for (const p of parts) {
    if (left <= 0) break;
    if (p.text.length > left) {
      out.push({ ...p, text: `${p.text.slice(0, left)}…` });
      return out;
    }
    out.push(p);
    left -= p.text.length;
  }
  const last = out[out.length - 1];
  out.push(last !== undefined ? { ...last, text: '…' } : { text: '…' });
  return out;
}

/** Lines as a column of `Text`, each in its tone or parts: a joined string view has none to give. */
export function linesView(lines: readonly Line[], theme: Theme): ReactNode {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text
          key={i}
          {...(l.tone !== undefined && l.parts === undefined ? { color: theme.color[l.tone] } : {})}
        >
          {l.parts !== undefined
            ? l.parts.map((p, j) => (
                <Text
                  key={j}
                  {...(p.tone !== undefined ? { color: theme.color[p.tone] } : {})}
                  {...(p.bg !== undefined ? { backgroundColor: theme.color[p.bg] } : {})}
                  {...(p.bold ? { bold: true } : {})}
                  {...(p.strike ? { strikethrough: true } : {})}
                >
                  {p.text}
                </Text>
              ))
            : l.text}
        </Text>
      ))}
    </Box>
  );
}
