/**
 * The line reader behind an interactive `substrate-admin onboard`. Driven through
 * PassThrough streams in terminal mode, so Ctrl-C arrives as the keypress it is.
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAsk } from '../src/admin/stdin-ask.js';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, output };
}

describe('createAsk', () => {
  it('resolves the typed line', async () => {
    const { input, output } = streams();
    const ask = createAsk({ input, output, terminal: true, onInterrupt: () => {} });
    const p = ask('name? ');
    input.write('substrate\r');
    expect(await p).toBe('substrate');
  });

  it('end of input resolves a pending question with null, and every later one too', async () => {
    const { input, output } = streams();
    const ask = createAsk({ input, output, terminal: true, onInterrupt: () => {} });
    const p = ask('q? ');
    input.end();
    expect(await p).toBeNull();
    expect(await ask('again? ')).toBeNull();
  });

  it('Ctrl-C at a prompt ends input — the loop prints its summary instead of hanging', async () => {
    const { input, output } = streams();
    let interrupted = false;
    const ask = createAsk({
      input,
      output,
      terminal: true,
      onInterrupt: () => {
        interrupted = true;
      }
    });
    const p = ask('q? ');
    input.write('\x03');
    expect(await p).toBeNull();
    expect(interrupted).toBe(false);
  });

  it('Ctrl-C with no prompt open (an action or fetch in flight) interrupts at once', async () => {
    const { input, output } = streams();
    let interrupted = false;
    const ask = createAsk({
      input,
      output,
      terminal: true,
      onInterrupt: () => {
        interrupted = true;
      }
    });
    const first = ask('q? ');
    input.write('ok\r');
    await first;
    input.write('\x03');
    await new Promise((r) => setImmediate(r));
    expect(interrupted).toBe(true);
  });
});
