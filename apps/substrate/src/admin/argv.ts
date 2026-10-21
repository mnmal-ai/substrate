/**
 * One argv contract for every subcommand, declared once.
 *
 * This owns exactly two questions: is this flag known, and is this positional
 * one too many. Everything semantic stays with each parser — duplicate
 * detection, mutual exclusion (`--direct` vs `--url`), required flags, value
 * SHAPES, and missing required positionals.
 */

import { argvError } from './usage.js';

export interface ArgvSpec {
  /** Flags that consume the following token. */
  readonly valueFlags: readonly string[];
  /** Flags that stand alone. */
  readonly boolFlags: readonly string[];
  /** Bare tokens accepted. Every command here takes either none or one `<kid>`. */
  readonly maxPositionals: number;
  /** Appended verbatim to the unknown-flag message, where one command adds one. */
  readonly hint?: string;
  /** Replaces the default excess-positional wording entirely. */
  readonly excess?: (tok: string) => string;
  /** `list` alone also accepts the `--flag=value` form. */
  readonly equalsForm?: boolean;
}

/**
 * The seven subcommands, and the whole of what each accepts.
 *
 * This table is also the definition of "known command": `main` refuses anything
 * absent from it BEFORE dispatching, so a subcommand added to the dispatch
 * switch without an entry here does not run at all.
 *
 * Per-command wording (`hint`, `excess`) and `list`'s `--url=` form are
 * deliberate and pinned by tests.
 */
export const ARGV_SPEC: Record<string, ArgvSpec> = {
  bootstrap: { valueFlags: [], boolFlags: ['--encrypt'], maxPositionals: 0 },
  doctor: {
    valueFlags: ['--url'],
    boolFlags: ['--direct'],
    maxPositionals: 0,
    hint: ' (accepts --url <base> or --direct)',
    excess: (tok) => `doctor: unexpected argument '${tok}' (accepts --url <base> or --direct)`
  },
  onboard: {
    valueFlags: ['--url'],
    boolFlags: ['--direct', '--check'],
    maxPositionals: 0,
    hint: ' (accepts --url <base> and --check)',
    excess: (tok) => `onboard: unexpected argument '${tok}' (accepts --url <base> and --check)`
  },
  list: {
    valueFlags: ['--url'],
    boolFlags: [],
    maxPositionals: 0,
    hint: ' (list accepts only --url <base>)',
    excess: (tok) => `list: unexpected argument '${tok}' (list accepts only --url <base>)`,
    equalsForm: true
  },
  revoke: {
    valueFlags: ['--url'],
    boolFlags: ['--direct'],
    maxPositionals: 1,
    excess: (tok) => `revoke: unexpected extra argument '${tok}' — one <kid> at a time`
  },
  rotate: { valueFlags: ['--out'], boolFlags: ['--encrypt'], maxPositionals: 1 },
  register: {
    valueFlags: ['--pubkey', '--name', '--ns', '--caps', '--url', '--project'],
    boolFlags: [
      '--allow-admin',
      '--allow-unknown-ns',
      '--direct',
      '--no-directory',
      '--no-broadcast'
    ],
    maxPositionals: 1
  },
  update: {
    valueFlags: ['--name', '--ns', '--caps', '--url'],
    boolFlags: ['--direct', '--allow-unknown-ns', '--widen', '--allow-admin'],
    maxPositionals: 1
  }
};

/** A command with no descriptor accepts nothing at all. */
const FAIL_CLOSED: ArgvSpec = { valueFlags: [], boolFlags: [], maxPositionals: 0 };

/**
 * Refuse unknown flags and surplus positionals for `cmd`, given its tail
 * (argv WITHOUT the subcommand name).
 *
 * Pure and idempotent, which is why it is safe to call from both `main` —
 * once, before dispatch — and from each `parse*Args`. The parsers are exported
 * from `bin/substrate-admin.ts` and called directly, so they cannot delegate their
 * guarantee to a caller they do not have.
 */
export function validateArgv(cmd: string, tail: readonly string[]): void {
  const spec = ARGV_SPEC[cmd] ?? FAIL_CLOSED;
  let positionals = 0;

  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i];
    if (tok === undefined) continue;

    if (tok.startsWith('--')) {
      if (spec.valueFlags.includes(tok)) {
        const next = tail[i + 1];
        // Consume the next token as this flag's value UNLESS it is itself a
        // flag this command knows. Both halves are load-bearing, and each is
        // pinned by a test that the other half breaks:
        //
        //   list --url --nonsense       consume it, so `list`'s own guard
        //                               answers "--url requires a base URL"
        //   register --pubkey --name x  do NOT consume `--name`, or `x` becomes
        //                               a stray positional and the operator is
        //                               told the wrong thing entirely
        //
        // The shape of a value is the command's question, not this function's:
        // every command taking a value checks it and says so in its own words.
        const nextIsKnownFlag =
          next !== undefined && (spec.valueFlags.includes(next) || spec.boolFlags.includes(next));
        if (next !== undefined && !nextIsKnownFlag) i += 1;
        continue;
      }
      if (spec.boolFlags.includes(tok)) continue;
      if (spec.equalsForm === true && spec.valueFlags.some((f) => tok.startsWith(`${f}=`)))
        continue;
      throw argvError(cmd, `${cmd}: unknown flag ${tok}${spec.hint ?? ''}`, 1);
    }

    positionals += 1;
    if (positionals > spec.maxPositionals) {
      throw argvError(cmd, spec.excess?.(tok) ?? `${cmd}: unexpected positional arg '${tok}'`, 1);
    }
  }
}
