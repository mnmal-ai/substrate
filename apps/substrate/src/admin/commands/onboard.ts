/**
 * `substrate-admin onboard` — guided onboarding. Runs diagnose, plans the steps,
 * stops at the first one still to do, and offers to run its fix when a client
 * can. Every action is confirmed; nothing runs unattended.
 */

import {
  CURRENT_MARK,
  currentStep,
  type DiagnoseResult,
  type OnboardAction,
  type OnboardStep,
  planOnboarding,
  requiredOutstanding,
  SKIPPABLE_STEPS,
  STEP_MARKS
} from '@mnmal-ai/substrate-client';
import { grantEntryError } from '@mnmal-ai/substrate-compose';
import { validateArgv } from '../argv.js';
import type { AdminCliEnv } from '../env.js';
import { resolveAdminTarget } from '../identity.js';
import { DEFAULT_ADMIN_CAPABILITY } from '../keys.js';
import { REVOKE_EXIT_CODES, runKeyPatchViaRoute } from '../route.js';
import { argvError } from '../usage.js';
import { formatBootstrapOutput, runBootstrap, seedCapabilities } from './bootstrap.js';
import { DIRECT_TARGET_REFUSAL, diagnoseTarget, formatDoctorReport } from './doctor.js';
import { bootstrapBlockers, writeKeypair } from './onboard-keys.js';
import { formatRegisterOutput, type RegisterArgs, runRegisterViaRoute } from './register.js';

export interface OnboardIO {
  out(s: string): void;
  /** Resolves the typed line, or null at end of input. */
  ask(prompt: string): Promise<string | null>;
}

export interface OnboardActions {
  bootstrap(): Promise<string>;
  registerAdmin(kid: string, pubkeyPath: string): Promise<string>;
  registerAgent(kid: string, pubkeyPath: string, namespaces: readonly string[]): Promise<string>;
  revoke(kid: string): Promise<string>;
  /** Writes the keypair, and the kid beside it so the key can sign without SUBSTRATE_*_KID. */
  generateKeypair(
    privateKeyPath: string,
    kid: string
  ): { privateKeyPath: string; publicKeyPath: string; kidPath?: string };
}

export interface RunOnboardOpts {
  readonly diagnose: () => Promise<DiagnoseResult>;
  readonly canBootstrap: boolean;
  /** Redacted SUBSTRATE_DATABASE_URL, named in the bootstrap offer: `--url` cannot vouch for it. */
  readonly bootstrapStore?: string;
  /** SUBSTRATE_ADMIN_CAPABILITY, so the offered command matches the one that runs. Default `admin`. */
  readonly adminCapability?: string;
  readonly interactive: boolean;
  readonly io: OnboardIO;
  readonly actions: OnboardActions;
}

export function formatChecklist(steps: readonly OnboardStep[]): string {
  const current = currentStep(steps);
  const width = Math.max(...steps.map((s) => s.name.length));
  const lines = steps.map((s) => {
    const mark = s === current ? CURRENT_MARK : STEP_MARKS[s.status];
    const tag = s.optional ? ' (optional)' : '';
    return `  ${mark} ${s.name.padEnd(width)}  ${s.detail}${tag}`;
  });
  return `${lines.join('\n')}\n`;
}

function describeAction(
  action: OnboardAction,
  store: string | undefined,
  adminCapability: string
): string {
  switch (action.kind) {
    case 'bootstrap':
      return (
        `substrate-admin bootstrap — writes straight to SUBSTRATE_DATABASE_URL=${store ?? '(unset)'}. ` +
        'It must be the same database the server you named serves; nothing here can check that.'
      );
    case 'register-admin':
      return (
        `substrate-admin register <kid> --pubkey <path> --ns '*' ` +
        `--caps ${seedCapabilities(adminCapability).join(',')} --allow-admin --no-directory`
      );
    case 'register-agent':
      return 'substrate-admin register <kid> --pubkey <path> --ns <namespace,…>';
    case 'revoke':
      return action.kids.map((k) => `substrate-admin revoke ${k}`).join(' && ');
  }
}

/** Thrown when input ends mid-action; the loop turns it into a quit. */
class EndOfInput extends Error {}

async function need(io: OnboardIO, prompt: string): Promise<string> {
  const line = await io.ask(prompt);
  if (line === null) throw new EndOfInput();
  return line.trim();
}

/** Asks for a public key, offering to generate a keypair when the operator has none. */
async function publicKeyPath(
  io: OnboardIO,
  actions: OnboardActions,
  kid: string
): Promise<string | null> {
  const given = await need(io, 'public key path (Enter to generate a keypair here): ');
  if (given.length > 0) return given;
  io.out(
    'A private key must live with whoever will use it, and never travel. Generate it on the ' +
      'machine that will sign with it.\n'
  );
  const target = await need(io, 'write the new private key to (Enter to cancel): ');
  if (target.length === 0) return null;
  const written = actions.generateKeypair(target, kid);
  io.out(`wrote ${written.privateKeyPath} (0600) and ${written.publicKeyPath}\n`);
  if (written.kidPath !== undefined) {
    io.out(
      `wrote ${written.kidPath} — point the signing-key variable at the private key and the ` +
        'kid is read from beside it.\n'
    );
  }
  return written.publicKeyPath;
}

/** Runs one action. Returns the output to show, or null when the operator cancelled. */
async function perform(
  action: OnboardAction,
  io: OnboardIO,
  actions: OnboardActions
): Promise<string | null> {
  switch (action.kind) {
    case 'bootstrap':
      return actions.bootstrap();
    case 'register-admin': {
      const kid = await need(io, 'kid for the second admin: ');
      if (kid.length === 0) return null;
      const pub = await publicKeyPath(io, actions, kid);
      return pub === null ? null : actions.registerAdmin(kid, pub);
    }
    case 'register-agent': {
      const kid = await need(io, 'kid for the agent (e.g. myrepo-claude@host): ');
      if (kid.length === 0) return null;
      const pub = await publicKeyPath(io, actions, kid);
      if (pub === null) return null;
      const ns = await need(io, 'grant namespaces (comma-separated): ');
      const namespaces = ns
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (namespaces.length === 0) {
        io.out('a namespace is required\n');
        return null;
      }
      // The same check `register --ns` runs, so a typo fails here rather than as a 400.
      const grantError = grantEntryError(namespaces, ['read', 'mutate']);
      if (grantError !== null) {
        io.out(`grant '${ns}' refused: ${grantError}\n`);
        return null;
      }
      return actions.registerAgent(kid, pub, namespaces);
    }
    case 'revoke': {
      const done: string[] = [];
      for (const kid of action.kids) {
        const typed = await need(io, `type '${kid}' to revoke it: `);
        if (typed !== kid) {
          io.out(`'${typed}' did not match — ${kid} left alone\n`);
          continue;
        }
        // Each kid reports on its own, so a later failure cannot hide an earlier revoke.
        try {
          done.push(await actions.revoke(kid));
        } catch (err) {
          done.push(`failed: ${kid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return done.length > 0 ? done.join('\n') : null;
    }
  }
}

function summary(steps: readonly OnboardStep[], stopped: boolean): string {
  const skipped = steps.filter((s) => s.status === 'skipped').map((s) => s.name);
  const blocked = steps.filter((s) => s.status === 'blocked').map((s) => s.name);
  const head = stopped
    ? 'onboarding stopped before it finished.'
    : requiredOutstanding(steps)
      ? 'onboarding has required steps outstanding.'
      : 'onboarding complete.';
  const lines = [head];
  if (skipped.length > 0) lines.push(`skipped: ${skipped.join(', ')}`);
  if (blocked.length > 0) lines.push(`not checked: ${blocked.join(', ')}`);
  return `\n${lines.join('\n')}\n`;
}

export async function runOnboard(opts: RunOnboardOpts): Promise<number> {
  const { io, actions } = opts;
  const adminCapability = opts.adminCapability ?? DEFAULT_ADMIN_CAPABILITY;
  const skipped = new Set<string>();
  // The step whose action the operator declined. It is not re-offered while that step is
  // current; `r` offers it again, and moving to another step forgets the refusal.
  let declined: string | null = null;
  for (;;) {
    let result: DiagnoseResult;
    try {
      result = await opts.diagnose();
    } catch (err) {
      io.out(`diagnose failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    const steps = planOnboarding(result, { canBootstrap: opts.canBootstrap, skipped });
    io.out(`\n${formatChecklist(steps)}`);
    const step = currentStep(steps);
    // Quitting is only a failure while something required is still to do (spec §5).
    const exitCode = requiredOutstanding(steps) ? 1 : 0;
    if (step === undefined || !opts.interactive) {
      io.out(summary(steps, false));
      return exitCode;
    }
    if (declined !== step.name) declined = null;
    io.out(`\n${step.name}: ${step.detail}\n`);
    try {
      if (step.action !== undefined && declined === null) {
        io.out(
          `  would run: ${describeAction(step.action, opts.bootstrapStore, adminCapability)}\n`
        );
        const yes = (await need(io, 'Run it? [y/N] ')).toLowerCase() === 'y';
        if (yes) {
          try {
            const output = await perform(step.action, io, actions);
            if (output !== null) io.out(`${output}\n`);
          } catch (err) {
            if (err instanceof EndOfInput) throw err;
            io.out(`failed: ${err instanceof Error ? err.message : String(err)}\n`);
          }
          continue;
        }
        declined = step.name;
      }
      if (step.fix !== undefined) io.out(`  fix: ${step.fix}\n`);
      const offerRun = step.action !== undefined && declined === step.name;
      const choice = (
        await need(
          io,
          `Enter re-checks${offerRun ? ', r runs the fix' : ''}` +
            `${step.skippable ? ', s skips' : ''}, q quits: `
        )
      ).toLowerCase();
      if (choice === 'q') {
        io.out(summary(steps, true));
        return exitCode;
      }
      if (choice === 'r' && offerRun) declined = null;
      if (choice === 's') {
        if (SKIPPABLE_STEPS.has(step.name)) skipped.add(step.name);
        else io.out(`${step.name} cannot be skipped\n`);
      }
    } catch (err) {
      if (!(err instanceof EndOfInput)) throw err;
      io.out(summary(steps, true));
      return exitCode;
    }
  }
}

/** A postgres URL fit to print: the password is never echoed. */
export function redactStore(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '(an unparseable postgres URL)';
  }
  const auth = u.username.length > 0 ? `${u.username}${u.password.length > 0 ? ':***' : ''}@` : '';
  return `${u.protocol}//${auth}${u.host}${u.pathname}`;
}

function registerArgs(kid: string, pubkeyPath: string, over: Partial<RegisterArgs>): RegisterArgs {
  return {
    kid,
    pubkeyPath,
    name: kid,
    namespaces: [],
    capabilities: ['read', 'mutate'],
    allowAdmin: false,
    allowUnknownNs: false,
    url: null,
    noDirectory: false,
    noBroadcast: false,
    project: null,
    ...over
  };
}

/** The production action runners: the same functions the standalone subcommands call. */
export function realOnboardActions(
  env: AdminCliEnv,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): OnboardActions {
  const cap =
    env.SUBSTRATE_ADMIN_CAPABILITY !== undefined && env.SUBSTRATE_ADMIN_CAPABILITY.length > 0
      ? env.SUBSTRATE_ADMIN_CAPABILITY
      : DEFAULT_ADMIN_CAPABILITY;
  return {
    bootstrap: async () => formatBootstrapOutput(await runBootstrap(env)),
    registerAdmin: async (kid, pub) =>
      formatRegisterOutput(
        await runRegisterViaRoute(
          // The bootstrap key's own grant: a second admin exists to replace the first,
          // so anything narrower would not deliver succession.
          registerArgs(kid, pub, {
            namespaces: ['*'],
            capabilities: seedCapabilities(cap),
            allowAdmin: true,
            // Admin roots are directory-exempt by capability, like the bootstrap key.
            noDirectory: true
          }),
          baseUrl,
          env,
          fetchImpl
        ),
        { adminRoot: true }
      ),
    registerAgent: async (kid, pub, namespaces) =>
      formatRegisterOutput(
        await runRegisterViaRoute(
          registerArgs(kid, pub, { namespaces: [...namespaces] }),
          baseUrl,
          env,
          fetchImpl
        )
      ),
    revoke: async (kid) => {
      await runKeyPatchViaRoute({ kid, revoke: true }, baseUrl, env, REVOKE_EXIT_CODES, fetchImpl);
      return `revoked ${kid}`;
    },
    generateKeypair: (path, kid) => writeKeypair(env, path, kid)
  };
}

/** Parse argv, resolve the target, and run — the shape `main` dispatches to. */
export async function onboardCommand(
  argv: readonly string[],
  env: AdminCliEnv,
  io: OnboardIO,
  interactive: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  validateArgv('onboard', argv);
  let url: string | undefined;
  let direct = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--url') {
      if (url !== undefined) {
        throw argvError('onboard', 'onboard: --url specified more than once', 1);
      }
      url = argv[i + 1] ?? '';
      i += 1;
    } else if (tok === '--direct') {
      direct = true;
    } else if (tok === '--check') {
      check = true;
    }
  }
  // `--direct` is accepted only so it can be refused with doctor's explanation.
  const target = resolveAdminTarget(direct ? '' : (url ?? null), env);
  if (target.kind !== 'route') {
    io.out(formatDoctorReport({ checks: [DIRECT_TARGET_REFUSAL], exitCode: 1 }));
    return 1;
  }
  const store = env.SUBSTRATE_DATABASE_URL ?? '';
  // Bootstrap is offered only when it can succeed: a postgres store, and none of the
  // files its own guards refuse on. Otherwise the credential step shows its fix instead.
  const canBootstrap =
    (store.startsWith('postgres://') || store.startsWith('postgresql://')) &&
    bootstrapBlockers(env).length === 0;
  return runOnboard({
    diagnose: () => diagnoseTarget(env, target.baseUrl, fetchImpl),
    canBootstrap,
    ...(canBootstrap ? { bootstrapStore: redactStore(store) } : {}),
    ...(env.SUBSTRATE_ADMIN_CAPABILITY !== undefined && env.SUBSTRATE_ADMIN_CAPABILITY.length > 0
      ? { adminCapability: env.SUBSTRATE_ADMIN_CAPABILITY }
      : {}),
    interactive: interactive && !check,
    io,
    actions: realOnboardActions(env, target.baseUrl, fetchImpl)
  });
}
