/**
 * `/keys`: the active key table; `r` toggles revoked keys in, dimmed with their revocation time
 * and read-only. Unlocked it reads as the admin identity: Enter edits a
 * row's grant (editor.tsx), `x` revokes it, `i` mints an invite and `n` registers a new key, each
 * through a review. Locked, it reads as the agent, which a 403 turns into "admin required", and
 * Enter shows a row's grant read-only. Locking closes the table and every editor panel.
 */

import { type AdminKeyRow, AuthError, describeGrant } from '@mnmal-ai/substrate/client';
import { defineModule, type ModuleCtx, sanitise, type TuiModule } from '@mnmal-ai/surface-core';
import { truncateCells } from '@mnmal-ai/surface-kit';
import { adminCapabilityOf } from '../admin/session.js';
import type { TuiDeps } from '../deps.js';
import { type Line, linesView } from '../lines.js';
// A runtime cycle once editor imports loadKeys back (Tasks 6/7), safe because each side uses the other only inside functions.
import { type EditorPanels, editorPanels, KEYS_CHROME, openEditor, switchTo } from './editor.js';
import { compactGrant, GRANT_LEGEND } from './grant.js';
import { revokeVerdict } from './verdict.js';

export interface KeysState {
  source: 'agent' | 'admin';
  rows: AdminKeyRow[] | null;
  note: string | null;
  cursor: number;
  detail: boolean;
  /** Revoked rows are listed too (`r`). */
  revoked: boolean;
}
export type KeysPanels = { keys: KeysState } & EditorPanels;
type Panels = KeysPanels;
type Ctx = ModuleCtx<Panels>;

const isRevoked = (r: AdminKeyRow) => typeof r.revokedAt === 'string';
/** The rows the editor flows judge against: a revoked key holds no grant. */
const live = (rows: readonly AdminKeyRow[]) => rows.filter((r) => !isRevoked(r));

/** Opens the table and reads it; `select` is a kid whose row takes the cursor once the read lands. */
export async function loadKeys(
  ctx: Ctx,
  deps: TuiDeps,
  select?: string,
  revoked = false
): Promise<void> {
  const source: KeysState['source'] = deps.admin.unlocked() ? 'admin' : 'agent';
  ctx.open('keys', { source, rows: null, note: null, cursor: 0, detail: false, revoked });
  const filter = revoked ? ('all' as const) : ('active' as const);
  try {
    const rows =
      source === 'admin'
        ? await deps.admin.run(({ client }) => client.admin.keys({ signal: ctx.signal, filter }))
        : await deps.keys(ctx.signal, filter);
    const at = select === undefined ? -1 : rows.findIndex((r) => r.kid === select);
    const cursor = Math.max(0, at);
    // Only into the table this read opened: a late admin read never lands in an agent table.
    const mine = (s: KeysState) => s.source === source && s.revoked === revoked;
    ctx.update('keys', (s) => (mine(s) ? { ...s, rows, cursor } : s));
  } catch (err) {
    // As admin, a coded refusal other than the auth gate's is the route's own: say what it said.
    const routeRefusal =
      source === 'admin' &&
      err instanceof AuthError &&
      err.code !== undefined &&
      err.code !== 'forbidden';
    const note = routeRefusal
      ? `could not read keys: ${err.code}: ${err.serverMessage ?? err.message}`
      : err instanceof AuthError
        ? 'admin required — /admin unlock'
        : `could not read keys: ${err instanceof Error ? err.message : String(err)}`;
    ctx.update('keys', (s) =>
      s.source === source && s.revoked === revoked ? { ...s, rows: null, note } : s
    );
  }
}

export function keysModule(deps: TuiDeps): TuiModule<Panels> {
  const move = (d: number) => (s: KeysState) =>
    s.rows === null || s.detail
      ? undefined
      : { ...s, cursor: Math.max(0, Math.min(s.rows.length - 1, s.cursor + d)) };

  return defineModule<Panels>('substrate.keys', {
    commands: [
      {
        name: 'keys',
        summary: 'the active key table',
        args: [],
        run: (_, ctx) => loadKeys(ctx, deps)
      }
    ],
    panels: {
      keys: {
        ...KEYS_CHROME,
        view: ({ state, theme, size }) => {
          const w = Math.max(1, size.columns - 2);
          const gone = state.rows === null ? 0 : state.rows.filter(isRevoked).length;
          const count =
            state.rows === null
              ? ''
              : ` · ${state.rows.length - gone} active${state.revoked ? ` · ${gone} revoked` : ''}`;
          const head = `${theme.glyph.title} keys${count} · ${state.source}`;
          if (state.note !== null) return [head, `  ${sanitise(state.note)}`].join('\n');
          if (state.rows === null) return [head, '  reading…'].join('\n');
          const pick = state.rows[state.cursor];
          if (state.detail && pick !== undefined) {
            return [
              head,
              truncateCells(sanitise(`  ${pick.kid}  ${pick.name}  ${pick.algorithm}`), w),
              ...(isRevoked(pick)
                ? [truncateCells(sanitise(`  revoked ${pick.revokedAt}`), w)]
                : []),
              ...describeGrant(pick.namespaces, pick.capabilities).map((g) =>
                truncateCells(sanitise(`    ${g}`), w)
              ),
              '  backspace back · esc close'
            ].join('\n');
          }
          const kidW = Math.min(40, Math.max(4, ...state.rows.map((r) => r.kid.length)));
          const nameW = Math.min(24, Math.max(4, ...state.rows.map((r) => r.name.length)));
          // Head, legend and hints take three rows.
          const max = Math.max(1, size.rows - 3);
          const start = Math.max(0, Math.min(state.cursor - max + 1, state.rows.length - max));
          const lines = state.rows.slice(start, start + max).map((r, k): Line => {
            const mark = start + k === state.cursor ? theme.glyph.cursor : ' ';
            const grant = compactGrant(r.namespaces, r.capabilities);
            const gone = isRevoked(r);
            const text = truncateCells(
              sanitise(
                `${mark} ${r.kid.padEnd(kidW)}  ${r.name.padEnd(nameW)}  ${gone ? `revoked ${r.revokedAt}  ` : ''}${grant}`
              ),
              w
            );
            return gone ? { text, tone: 'dim' } : { text };
          });
          const toggle = state.revoked ? 'r hide revoked' : 'r show revoked';
          return linesView(
            [
              { text: head },
              ...lines,
              { text: truncateCells(`  ${GRANT_LEGEND}`, w) },
              {
                text:
                  state.source === 'admin' && deps.admin.unlocked()
                    ? `  ↑↓/jk move · enter edit · x revoke · i invite · n register · ${toggle} · esc close`
                    : `  ↑↓/jk move · enter grant · ${toggle} · esc close`
              }
            ],
            theme
          );
        },
        keymap: [
          { key: 'up', act: 'up' },
          { key: 'k', act: 'up' },
          { key: 'down', act: 'down' },
          { key: 'j', act: 'down' },
          { key: 'enter', act: 'in' },
          { key: 'backspace', act: 'out' },
          { key: 'n', act: 'register' },
          { key: 'i', act: 'invite' },
          { key: 'x', act: 'revoke' },
          { key: 'r', act: 'toggleRevoked' }
        ],
        on: {
          up: move(-1),
          down: move(1),
          in: (s, ctx) => {
            if (s.rows === null || s.rows.length === 0) return undefined;
            const row = s.rows[s.cursor] as AdminKeyRow;
            // A revoked row is read-only: Enter shows its grant, never the editor.
            if (deps.admin.unlocked() && s.source === 'admin' && !isRevoked(row)) {
              void openEditor(ctx, deps, { kind: 'update', row }, live(s.rows));
              return undefined;
            }
            return { ...s, detail: true };
          },
          out: (s) => (s.detail ? { ...s, detail: false } : undefined),
          toggleRevoked: (s, ctx) => {
            if (s.detail || (s.rows === null && s.note === null)) return undefined;
            void loadKeys(ctx, deps, s.rows?.[s.cursor]?.kid, !s.revoked);
            return undefined;
          },
          register: (s, ctx) => {
            if (!(deps.admin.unlocked() && s.source === 'admin' && s.rows !== null && !s.detail)) {
              return undefined;
            }
            ctx.setDraft('');
            switchTo(ctx, deps, 'prompt', {
              purpose: 'reg-kid',
              label: 'kid to register',
              error: null,
              back: null,
              table: live(s.rows)
            });
            return undefined;
          },
          invite: (s, ctx) => {
            if (!(deps.admin.unlocked() && s.source === 'admin' && s.rows !== null && !s.detail)) {
              return undefined;
            }
            void openEditor(ctx, deps, { kind: 'invite' }, live(s.rows));
            return undefined;
          },
          revoke: (s, ctx) => {
            if (!(deps.admin.unlocked() && s.source === 'admin' && s.rows !== null && !s.detail)) {
              return undefined;
            }
            const row = s.rows[s.cursor];
            if (row === undefined || isRevoked(row)) return undefined;
            const table = live(s.rows);
            ctx.setDraft('');
            switchTo(ctx, deps, 'review', {
              flow: { kind: 'revoke', row },
              edit: null,
              next: null,
              verdict: revokeVerdict({
                kid: row.kid,
                table,
                adminCapability: adminCapabilityOf(deps.adminEnv).adminCapability ?? 'admin'
              }),
              stage: 'review',
              error: null,
              mismatch: false,
              table
            });
            return undefined;
          }
        }
      },
      ...editorPanels(deps)
    },
    init(ctx) {
      // An admin-read table never outlives the unlock that read it. `update` runs its fn
      // only while this panel is open, so it doubles as the probe.
      const off = deps.admin.onChange((st) => {
        if (st.kind !== 'locked') return;
        let adminOpen = false;
        ctx.update('keys', (s) => {
          adminOpen = s.source === 'admin';
          return s;
        });
        for (const p of ['edit', 'prompt', 'review'] as const) {
          ctx.update(p, (x) => {
            // The stage showing a freshly minted invite code does nothing as admin, and closing
            // it would lose a code that is not shown again.
            const showingCode = p === 'review' && 'inviteCode' in x && x.inviteCode !== undefined;
            if (!showingCode) adminOpen = true;
            return x;
          });
        }
        if (adminOpen) {
          ctx.close();
          ctx.print('keys closed — admin locked', 'warn');
        }
      });
      return () => {
        off();
      };
    }
  });
}
