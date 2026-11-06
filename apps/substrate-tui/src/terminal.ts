import { type PrepareTerminalOptions, resolveFullscreen } from '@mnmal-ai/surface-core/pure';

/**
 * How substrate-tui prepares the terminal: a black ground, and full-screen unless
 * `SURFACE_FULLSCREEN=off`, which gives a fresh, bottom-anchored pane instead.
 * `SUBSTRATE_TUI_BACKGROUND` takes `#rrggbb` or `none`; `SUBSTRATE_TUI_CLEAR=0` keeps what was on
 * screen (full-screen never clears: it draws on the alternate screen).
 */
export function terminalOptions(env: Record<string, string | undefined>): PrepareTerminalOptions {
  return {
    ...(env.SUBSTRATE_TUI_BACKGROUND !== undefined ? { ground: env.SUBSTRATE_TUI_BACKGROUND } : {}),
    clear: (env.SUBSTRATE_TUI_CLEAR ?? '').trim() !== '0',
    // The same switch the app resolves in run(): this app sets no `fullscreen` option.
    fullscreen: resolveFullscreen(undefined, env.SURFACE_FULLSCREEN).on
  };
}

/**
 * The environment chalk must see for the theme's hex colours to reach the terminal as hex
 *. chalk picks its depth once, at import, and reports 256 colours for any TERM
 * ending `-256color`, rounding every hex to the nearest palette entry; COLORTERM=truecolor is the
 * one check it makes first. So: truecolor by default, a COLORTERM the terminal already set is left
 * alone, and `SUBSTRATE_TUI_COLOR=256` opts out for a terminal that cannot render 24-bit colour.
 * Must be applied before Ink (and so chalk) is imported.
 */
export function colorDepthEnv(env: Record<string, string | undefined>): Record<string, string> {
  if ((env.SUBSTRATE_TUI_COLOR ?? '').trim() === '256') return {};
  if (env.COLORTERM !== undefined && env.COLORTERM !== '') return {};
  return { COLORTERM: 'truecolor' };
}
