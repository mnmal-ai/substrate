import { prepareSequence } from '@mnmal-ai/surface-core/pure';
import { describe, expect, it } from 'vitest';
import { colorDepthEnv, terminalOptions } from '../src/terminal.js';

describe('terminalOptions', () => {
  it('defaults to the black ground and a clear', () => {
    expect(terminalOptions({})).toEqual({ clear: true, fullscreen: true });
    expect(prepareSequence(2, terminalOptions({ SURFACE_FULLSCREEN: 'off' }))).toBe(
      '\x1b]11;#000000\x07\x1b[2J\x1b[3J\x1b[H\n'
    );
  });
  it('SUBSTRATE_TUI_BACKGROUND overrides or opts out; SUBSTRATE_TUI_CLEAR=0 keeps the screen', () => {
    expect(
      prepareSequence(
        2,
        terminalOptions({
          SUBSTRATE_TUI_BACKGROUND: 'none',
          SUBSTRATE_TUI_CLEAR: '0',
          SURFACE_FULLSCREEN: 'off'
        })
      )
    ).toBe('\n');
    expect(terminalOptions({ SUBSTRATE_TUI_BACKGROUND: '#13171e' }).ground).toBe('#13171e');
  });
});

describe('terminalOptions in full-screen', () => {
  it('follows SURFACE_FULLSCREEN, on by default', () => {
    expect(terminalOptions({}).fullscreen).toBe(true);
    expect(terminalOptions({ SURFACE_FULLSCREEN: 'off' }).fullscreen).toBe(false);
  });
  it('full-screen never clears the shell it started from', () => {
    expect(prepareSequence(2, terminalOptions({ SUBSTRATE_TUI_BACKGROUND: 'none' }))).toBe(
      '\x1b[?1007l'
    );
  });
});

describe('colorDepthEnv', () => {
  it('defaults to truecolor', () => {
    expect(colorDepthEnv({ TERM: 'xterm-256color' })).toEqual({ COLORTERM: 'truecolor' });
    expect(colorDepthEnv({ COLORTERM: '' })).toEqual({ COLORTERM: 'truecolor' });
  });
  it("leaves the terminal's own COLORTERM, and SUBSTRATE_TUI_COLOR=256 opts out", () => {
    expect(colorDepthEnv({ COLORTERM: '24bit' })).toEqual({});
    expect(colorDepthEnv({ SUBSTRATE_TUI_COLOR: ' 256 ' })).toEqual({});
  });
});
