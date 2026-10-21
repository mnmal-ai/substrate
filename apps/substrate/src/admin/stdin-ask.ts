/**
 * The line reader behind an interactive `substrate-admin onboard`.
 *
 * - End of input (Ctrl-D, a closed pipe) resolves the open question, and every later
 *   one, with null — the loop turns that into a quit with its summary.
 * - Ctrl-C at a prompt does the same. Ctrl-C with no prompt open (an action or a fetch in
 *   flight) calls `onInterrupt`, because no prompt will come back to notice a close.
 * - `terminal` is set from the INPUT, so redirecting stderr cannot turn Ctrl-C back into
 *   a process-killing SIGINT.
 * - One pending resolver and one permanent close listener, so nothing accumulates per
 *   question.
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface AskStreams {
  readonly input: Readable;
  readonly output: Writable;
  readonly terminal: boolean;
  readonly onInterrupt: () => void;
}

export function createAsk(streams: AskStreams): (prompt: string) => Promise<string | null> {
  const rl = createInterface({
    input: streams.input,
    output: streams.output,
    terminal: streams.terminal
  });
  let closed = false;
  let pending: ((line: string | null) => void) | null = null;
  const settle = (line: string | null) => {
    const resolve = pending;
    pending = null;
    resolve?.(line);
  };
  rl.on('close', () => {
    closed = true;
    settle(null);
  });
  rl.on('SIGINT', () => {
    if (pending !== null) rl.close();
    else streams.onInterrupt();
  });
  return (prompt) => {
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      pending = resolve;
      rl.question(prompt, (line) => settle(line));
    });
  };
}
