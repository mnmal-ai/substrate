/**
 * `/admin unlock|lock|status`. Unlock resolves the admin credential the way
 * `substrate-admin` does, asks for a passphrase on a masked panel when the key is encrypted, and
 * verifies the identity with `diagnose` before the session holds anything: a key that is not an
 * admin fails here, not at the first write.
 */

import {
  adminClaimCapabilities,
  type DiagnoseResult,
  isEncryptedKey,
  makeTokenProvider,
  diagnose as realDiagnose,
  resolveAdminCredential,
  tokenAudience
} from '@mnmal-ai/substrate/client';
import { defineModule, type ModuleCtx, sanitise, type TuiModule } from '@mnmal-ai/surface-core';
import type { TuiDeps } from '../deps.js';
import { adminCapabilityOf } from './session.js';

export type AdminPanels = {
  passphrase: { keyPath: string; kid: string; error: string | null; busy: boolean };
};
type Ctx = ModuleCtx<AdminPanels>;

const STATUS_ID = 'admin';

function badge(deps: TuiDeps, now: number): string | null {
  const s = deps.admin.state();
  if (s.kind !== 'unlocked') return null;
  return `admin ${s.kid} · ${Math.max(0, Math.ceil((s.idleUntil - now) / 60_000))}m`;
}

/** The first check that answered no, as one printable line with its fix. */
function refusal(r: DiagnoseResult): string {
  const no = r.checks.find((c) => c.status === 'no');
  if (no === undefined) return 'admin not confirmed: the admin check did not run';
  return `${no.name}: ${no.detail}${no.fix !== undefined ? ` — fix: ${no.fix}` : ''}`;
}

export function adminModule(
  deps: TuiDeps,
  io: { diagnose?: typeof realDiagnose } = {}
): TuiModule<AdminPanels> {
  const diagnose = io.diagnose ?? realDiagnose;
  /**
   * Bumped by exactly three things: Esc on the passphrase panel, `/admin lock` (whether or not
   * admin is held) and teardown. An attempt whose captured value is stale grants nothing.
   */
  let generation = 0;
  /** Verifications awaiting diagnose, so `/admin lock` can say it cancelled one. */
  let pending = 0;
  /** Verify, then hold. Resolves to null on success, undefined when abandoned, else the refusal line. */
  const verifyAndUnlock = async (
    getAuthorization: () => string,
    label: string,
    fallbackKid: string | null,
    getToken: () => string
  ): Promise<string | null | undefined> => {
    const mine = generation;
    pending += 1;
    try {
      return await verify(mine, getAuthorization, label, fallbackKid, getToken);
    } finally {
      pending -= 1;
    }
  };
  const verify = async (
    mine: number,
    getAuthorization: () => string,
    label: string,
    fallbackKid: string | null,
    getToken: () => string
  ): Promise<string | null | undefined> => {
    let r: DiagnoseResult;
    try {
      r = await diagnose({
        baseUrl: deps.endpoint,
        credential: { authorization: getAuthorization, label },
        ...adminCapabilityOf(deps.adminEnv)
      });
    } catch (err) {
      return mine === generation
        ? `could not verify: ${err instanceof Error ? err.message : String(err)}`
        : undefined;
    }
    if (mine !== generation) return undefined;
    if (r.checks.find((c) => c.name === 'admin-capability')?.status !== 'ok') return refusal(r);
    deps.admin.unlock(r.identity ?? fallbackKid ?? 'admin', getToken);
    return null;
  };

  const unlockWithKey = async (keyPath: string, kid: string, passphrase: string | undefined) => {
    const getToken = makeTokenProvider(
      { keyPath, kid },
      {
        capabilities: adminClaimCapabilities(deps.adminEnv),
        audience: tokenAudience(deps.endpoint),
        ...(passphrase !== undefined ? { passphrase } : {})
      }
    );
    return verifyAndUnlock(() => `Bearer ${getToken()}`, keyPath, kid, getToken);
  };

  return defineModule<AdminPanels>('substrate.admin', {
    commands: [
      {
        name: 'admin',
        summary: 'unlock or lock the admin identity',
        args: [{ name: 'unlock|lock|status', optional: true }],
        async run([action], ctx: Ctx) {
          if (action === 'lock') {
            generation += 1;
            if (!deps.admin.unlocked()) {
              return ctx.print(
                pending > 0 ? 'admin unlock cancelled' : 'admin is already locked',
                'dim'
              );
            }
            deps.admin.lock('locked by /admin lock');
            return;
          }
          if (action === undefined || action === 'status') {
            return ctx.print(badge(deps, Date.now()) ?? 'admin is locked — /admin unlock');
          }
          if (action !== 'unlock')
            return ctx.print(`unknown /admin action '${sanitise(action)}'`, 'warn');
          if (deps.admin.unlocked()) return ctx.print('admin is already unlocked', 'dim');
          const cred = resolveAdminCredential(deps.adminEnv);
          if (cred.kind === 'error') return ctx.print(sanitise(cred.error), 'error');
          if (cred.kind === 'token') {
            const authorization = cred.authorization;
            const bare = authorization.replace(/^Bearer /, '');
            const why = await verifyAndUnlock(
              () => authorization,
              'SUBSTRATE_ADMIN_TOKEN',
              null,
              () => bare
            );
            if (why !== null && why !== undefined) ctx.print(sanitise(why), 'error');
            return;
          }
          let encrypted: boolean;
          try {
            encrypted = isEncryptedKey(cred.keyPath);
          } catch (err) {
            return ctx.print(
              `cannot read ${sanitise(cred.keyPath)}: ${sanitise(err instanceof Error ? err.message : String(err))}`,
              'error'
            );
          }
          if (encrypted) {
            ctx.open('passphrase', {
              keyPath: cred.keyPath,
              kid: cred.kid,
              error: null,
              busy: false
            });
            return;
          }
          let why: string | null | undefined;
          try {
            why = await unlockWithKey(cred.keyPath, cred.kid, undefined);
          } catch (err) {
            why = `could not sign with ${cred.keyPath}: ${err instanceof Error ? err.message : String(err)}`;
          }
          if (why !== null && why !== undefined) ctx.print(sanitise(why), 'error');
        }
      }
    ],
    panels: {
      passphrase: {
        mask: true,
        view: ({ state, theme }) =>
          [
            `${theme.glyph.title} admin unlock · ${sanitise(state.kid)}`,
            `passphrase for ${sanitise(state.keyPath)}${state.busy ? ' · checking…' : ''}`,
            ...(state.error !== null ? [sanitise(state.error)] : []),
            '  type it and press enter · esc cancels'
          ].join('\n'),
        escape: () => {
          generation += 1;
          return undefined;
        },
        submit: (state, line, ctx) => {
          if (state.busy) return undefined;
          let getToken: () => string;
          try {
            getToken = makeTokenProvider(
              { keyPath: state.keyPath, kid: state.kid },
              { capabilities: adminClaimCapabilities(deps.adminEnv), passphrase: line }
            );
          } catch {
            return { ...state, error: 'wrong passphrase, or the key is unreadable' };
          }
          void verifyAndUnlock(
            () => `Bearer ${getToken()}`,
            state.keyPath,
            state.kid,
            getToken
          ).then((why) => {
            if (why === undefined) return;
            if (why === null) ctx.close();
            else ctx.update('passphrase', (s) => ({ ...s, busy: false, error: why }));
          });
          return { ...state, busy: true, error: null };
        }
      }
    },
    init(ctx) {
      const show = () => ctx.status(STATUS_ID, badge(deps, Date.now()), 'warn');
      const off = deps.admin.onChange((s) => {
        show();
        if (s.kind === 'locked' && s.reason !== null) {
          ctx.print(
            sanitise(s.reason.startsWith('admin locked') ? s.reason : `admin locked: ${s.reason}`),
            'warn'
          );
        }
      });
      const tickTimer = setInterval(show, 30_000);
      return () => {
        generation += 1;
        off();
        clearInterval(tickTimer);
        deps.admin.dispose();
      };
    }
  });
}
