import { type AppOptions, createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { adminModule } from './admin/module.js';
import { askModule } from './ask/module.js';
import { dashModule } from './dash/module.js';
import type { TuiDeps } from './deps.js';
import { doctorModule } from './doctor/module.js';
import { keysModule } from './keys/module.js';
import { schemaModule } from './schema/module.js';
import { statusModule } from './status/module.js';
import { surgeryModule } from './surgery/module.js';

// Status registers first so its substrate/ns listener exists before ask's init emits.
export function buildModules(
  deps: TuiDeps,
  opts: { intervalMs?: number; dashIntervalMs?: number; doctorIntervalMs?: number } = {}
): AppOptions['modules'] {
  return [
    statusModule(deps, opts),
    adminModule(deps),
    doctorModule(
      deps,
      opts.doctorIntervalMs !== undefined ? { intervalMs: opts.doctorIntervalMs } : {}
    ),
    keysModule(deps),
    surgeryModule(deps),
    askModule(deps),
    schemaModule(deps),
    dashModule(deps, opts.dashIntervalMs !== undefined ? { intervalMs: opts.dashIntervalMs } : {})
  ];
}

export function substrateAppOptions(
  deps: TuiDeps,
  opts: { intervalMs?: number; dashIntervalMs?: number; doctorIntervalMs?: number } = {}
): AppOptions {
  return {
    theme: marathon,
    modules: buildModules(deps, opts),
    defaultTurn: 'substrate.ask:ask',
    band: true,
    // Inset: two columns each side of the transcript, band and status row.
    gutter: 2,
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
