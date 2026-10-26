import { openPgDataset } from './dataset.js';
import type { AdminCliEnv } from './env.js';
import { main } from './main.js';
import { createAsk } from './stdin-ask.js';

/** Runs `substrate-admin` on this process's argv, then exits with its code. */
export function runAdminCli(): void {
  // Only an interactive onboard holds stdin open; every other subcommand stays scriptable.
  const interactive = process.stdin.isTTY === true && process.argv[2] === 'onboard';
  void main(
    process.argv.slice(2),
    process.env as AdminCliEnv,
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s),
    openPgDataset,
    interactive
      ? {
          ask: createAsk({
            input: process.stdin,
            output: process.stderr,
            terminal: true,
            // No prompt is open to notice a close, so leave now rather than after the request.
            onInterrupt: () => {
              process.stderr.write('\ninterrupted.\n');
              process.exit(130);
            }
          }),
          interactive: true
        }
      : { ask: async () => null, interactive: false }
  ).then((exitCode) => process.exit(exitCode));
}
