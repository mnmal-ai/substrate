/** A toned column of text lines, shared by the panels that render one (surgery, `/keys`). */

import type { Theme } from '@mnmal-ai/surface-theme';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

/** One line, toned. The text is rendered as given: callers sanitise. */
export interface Line {
  readonly text: string;
  readonly tone?: 'ok' | 'error' | 'warn' | 'dim';
}

/** Lines as a column of `Text`, each in its tone: a joined string view has no tone to give them. */
export function linesView(lines: readonly Line[], theme: Theme): ReactNode {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} {...(l.tone !== undefined ? { color: theme.color[l.tone] } : {})}>
          {l.text}
        </Text>
      ))}
    </Box>
  );
}
