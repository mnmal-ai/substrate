import { prepareSequence } from '@mnmal-ai/surface-core/pure';
import { describe, expect, it } from 'vitest';
import { colorDepthEnv, terminalOptions } from '../src/terminal.js';

describe('terminalOptions', () => {
  it('defaults to the black ground and a clear', () => {
    expect(terminalOptions({})).toEqual({ clear: true });
    expect(prepareSequence(2, terminalOptions({}))).toBe(
      '\x1b]11;#000000\x07\x1b[2J\x1b[3J\x1b[H\n'
    );
  });
  it('SUBSTRATE_TUI_BACKGROUND overrides or opts out; SUBSTRATE_TUI_CLEAR=0 keeps the screen', () => {
    expect(
      prepareSequence(
        2,
        terminalOptions({ SUBSTRATE_TUI_BACKGROUND: 'none', SUBSTRATE_TUI_CLEAR: '0' })
      )
    ).toBe('\n');
    expect(terminalOptions({ SUBSTRATE_TUI_BACKGROUND: '#13171e' }).ground).toBe('#13171e');
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
