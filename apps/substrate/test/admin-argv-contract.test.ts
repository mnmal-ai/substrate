/**
 * The argv contract binds the subcommand that does not exist yet.
 *
 * Per-command flag rejection is pinned in `substrate-admin-cli.test.ts`. This file
 * fails when someone adds a command WITHOUT declaring its shape in `ARGV_SPEC`.
 *
 * It scrapes the source because `main`'s dispatch switch is the list of things
 * the CLI will run and `ARGV_SPEC` the list it knows the shape of; neither can
 * be derived from the other without losing the ability to notice them
 * disagreeing. At runtime a case with no descriptor is already refused; this
 * fails at TEST time instead.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARGV_SPEC, validateArgv } from '../src/admin/argv.js';
import { main } from '../src/admin/main.js';
import { SYNOPSIS } from '../src/admin/usage.js';

/** The subcommands `main` will actually dispatch, read from its switch. */
function dispatchedCommands(): string[] {
  const src = readFileSync(new URL('../src/admin/main.ts', import.meta.url), 'utf8');
  return [...src.matchAll(/case '([a-z][a-z-]*)':/g)].map((m) => m[1] as string).sort();
}

async function run(argv: string[]): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const code = await main(
    argv,
    {},
    () => {},
    (s) => err.push(s)
  );
  return { code, err: err.join('') };
}

describe('every dispatched subcommand declares its argv shape', () => {
  it('the dispatch switch and ARGV_SPEC name the same commands', () => {
    // Both directions. A case without a descriptor is the eighth-subcommand
    // defect; a descriptor without a case is a stale entry that would quietly
    // keep a removed command reachable-looking.
    expect(dispatchedCommands()).toEqual(Object.keys(ARGV_SPEC).sort());
  });

  it('finds the nine that exist — so the scrape itself cannot be silently empty', () => {
    // A regex that matches nothing makes the assertion above vacuously true,
    // which is the failure mode this whole file exists to prevent, one level up.
    expect(dispatchedCommands()).toHaveLength(9);
  });

  it('declares every flag its own usage line advertises', () => {
    // SYNOPSIS is the prose contract and ARGV_SPEC is the enforced one. A flag
    // documented but not declared would be refused at the very moment an
    // operator copied it out of the usage text.
    const undeclared: string[] = [];
    for (const [cmd, synopsis] of Object.entries(SYNOPSIS)) {
      const spec = ARGV_SPEC[cmd];
      if (spec === undefined) {
        undeclared.push(`${cmd}: has a synopsis but no ARGV_SPEC entry`);
        continue;
      }
      const known = new Set([...spec.valueFlags, ...spec.boolFlags]);
      for (const m of synopsis.matchAll(/--[a-z][a-z-]*/g)) {
        if (!known.has(m[0])) undeclared.push(`${cmd}: ${m[0]} is in the synopsis, not the spec`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});

describe('a command with no descriptor is refused rather than trusted', () => {
  it('accepts NOTHING — not a flag, not a positional', () => {
    // The fail-closed default. This is what an eighth subcommand gets before
    // anyone declares its shape, and the point is that it is unusable rather
    // than unchecked.
    expect(() => validateArgv('frobnicate', ['--anything'])).toThrow(/unknown flag --anything/);
    expect(() => validateArgv('frobnicate', ['positional'])).toThrow(/unexpected positional arg/);
  });

  it('is not dispatched at all, and says so in the operator’s terms', async () => {
    // Refused as an unknown COMMAND rather than as a bad flag: the operator's
    // mistake is the command name, and naming the flag would send them to fix
    // the wrong half.
    const { code, err } = await run(['frobnicate', '--url', 'https://x']);

    expect(code).toBe(1);
    expect(err).toContain('unknown command: frobnicate');
    expect(err).not.toContain('unknown flag');
  });
});

describe('one implementation, reachable from both doors', () => {
  it('refuses through the CLI', async () => {
    // The parsers are exported and called directly, so the guarantee cannot
    // live only at the dispatch site; these two cases are the two doors.
    expect((await run(['rotate', 'k', '--nope'])).err).toContain('rotate: unknown flag --nope');
  });

  it('refuses through the exported parser, with the same words', () => {
    expect(() => validateArgv('rotate', ['k', '--nope'])).toThrow(/rotate: unknown flag --nope/);
  });

  it('carries the usage line for EVERY subcommand, doctor included', () => {
    // Asserted over the whole table rather than on one command, so the next
    // subcommand cannot quietly drop the usage line.
    const missing = Object.keys(ARGV_SPEC).filter((cmd) => {
      try {
        validateArgv(cmd, ['--definitely-not-a-flag']);
        return true; // refused nothing at all — worse than a missing usage line
      } catch (err) {
        return !/usage: substrate-admin /.test(err instanceof Error ? err.message : '');
      }
    });
    expect(missing).toEqual([]);
  });
});
