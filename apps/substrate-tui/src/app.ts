import { type AppOptions, createApp, listPager } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { Box, Text } from 'ink';
import { createElement } from 'react';
import { adminModule } from './admin/module.js';
import { askModule } from './ask/module.js';
import { dashModule } from './dash/module.js';
import type { TuiDeps } from './deps.js';
import { doctorModule } from './doctor/module.js';
import { keysModule } from './keys/module.js';
import { schemaModule } from './schema/module.js';
import { statusModule } from './status/module.js';
import { surgeryModule } from './surgery/module.js';

/** marathon with no overlay fill: an empty `raised` means Ink paints no background, so panels sit on the ground. */
export const substrateTheme = { ...marathon, color: { ...marathon.color, raised: '' } };

// Status registers first so its substrate/ns listener exists before ask's init emits.
export function buildModules(
  deps: TuiDeps,
  opts: { intervalMs?: number; dashIntervalMs?: number; doctorIntervalMs?: number } = {}
): AppOptions['modules'] {
  const pager = listPager();
  return [
    statusModule(deps, opts),
    adminModule(deps),
    doctorModule(
      deps,
      opts.doctorIntervalMs !== undefined ? { intervalMs: opts.doctorIntervalMs } : {}
    ),
    keysModule(deps),
    surgeryModule(deps),
    askModule(deps, pager),
    pager.module,
    schemaModule(deps),
    dashModule(deps, opts.dashIntervalMs !== undefined ? { intervalMs: opts.dashIntervalMs } : {})
  ];
}

export function substrateAppOptions(
  deps: TuiDeps,
  opts: { intervalMs?: number; dashIntervalMs?: number; doctorIntervalMs?: number } = {}
): AppOptions {
  return {
    theme: substrateTheme,
    modules: buildModules(deps, opts),
    defaultTurn: 'substrate.ask:ask',
    band: true,
    // Inset: two columns each side of the transcript, band and status row.
    gutter: 2,
    // An answer is the surface default (its ↩ mark, then body and chips) plus a blank row beneath.
    entries: {
      answer: ({ entry, body, theme }) =>
        createElement(
          Box,
          { flexDirection: 'column', marginBottom: 1 },
          entry.mark !== null
            ? createElement(Text, { color: theme.color.accent }, `↩ ⟨${entry.mark}⟩`)
            : null,
          body
        )
    },
    // Keep the input on the last row when the live region shrinks, a panel closes or the terminal resizes.
    anchored: true,
    // The bin prepares the terminal (ground, clear) from SUBSTRATE_TUI_* before run() and restores it.
    terminal: false
  };
}

// Typed via createApp because surface-core does not export AppProps, which the inferred type would need.
export function createTui(
  deps: TuiDeps,
  opts: { intervalMs?: number; dashIntervalMs?: number; doctorIntervalMs?: number } = {}
): ReturnType<typeof createApp> {
  return createApp(substrateAppOptions(deps, opts));
}
