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
import { type Line, linesView, type Part, partsLine, truncateParts } from '../lines.js';
import { clean } from '../text.js';
// A runtime cycle once editor imports loadKeys back (Tasks 6/7), safe because each side uses the other only inside functions.
import { type EditorPanels, editorPanels, KEYS_CHROME, openEditor, switchTo } from './editor.js';
import { GRANT_LEGEND } from './grant.js';
import { isRevoked, listLines, orderForView, selectLine } from './layout.js';
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
const count = (s: KeysState): string => {
  if (s.rows === null) return '';
  const gone = s.rows.filter(isRevoked).length;
  return ` · ${s.rows.length - gone} active${s.revoked ? ` · ${gone} revoked` : ''}`;
};

/** The head line: accent glyph, bold `keys`, then the counts and source in dimMid. */
export function headParts(state: KeysState, titleGlyph: string): Part[] {
  return [
    { text: titleGlyph, tone: 'accent' },
    { text: ' ' },
    { text: 'keys', tone: 'text', bold: true },
    { text: `${count(state)} · ${state.source}`, tone: 'dimMid' }
  ];
}

/** The grant legend, dim with its `a` in warn bold. */
export function legendParts(): Part[] {
  return [
    { text: `  ${GRANT_LEGEND.slice(0, GRANT_LEGEND.lastIndexOf('a='))}`, tone: 'dim' },
    { text: 'a', tone: 'warn', bold: true },
    { text: GRANT_LEGEND.slice(GRANT_LEGEND.lastIndexOf('a=') + 1), tone: 'dim' }
  ];
}

/** Key hints: key names text, actions dimMid, `·` separators dim. */
export function hintParts(pairs: readonly (readonly [key: string, action: string])[]): Part[] {
  return [
    { text: '  ' },
    ...pairs.flatMap(([key, action], i): Part[] => [
      ...(i > 0 ? [{ text: ' · ', tone: 'dim' as const }] : []),
      { text: key, tone: 'text' },
      { text: ` ${action}`, tone: 'dimMid' }
    ])
  ];
}

export type KeysPanels = { keys: KeysState } & EditorPanels;
type Panels = KeysPanels;
type Ctx = ModuleCtx<Panels>;

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
    const rows = orderForView(
      source === 'admin'
        ? await deps.admin.run(({ client }) => client.admin.keys({ signal: ctx.signal, filter }))
        : await deps.keys(ctx.signal, filter)
    );
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
          // The core hands the view its content width, the panel's inset already taken off.
          const w = size.columns;
          const headLine = partsLine(truncateParts(headParts(state, theme.glyph.title), w));
          if (state.note !== null)
            return linesView([headLine, { text: `  ${sanitise(state.note)}` }], theme);
          if (state.rows === null) return linesView([headLine, { text: '  reading…' }], theme);
          const pick = state.rows[state.cursor];
          if (state.detail && pick !== undefined) {
            const detail = [
              truncateCells(clean(`  ${pick.kid}  ${pick.name}  ${pick.algorithm}`), w),
              ...(isRevoked(pick) ? [truncateCells(clean(`  revoked ${pick.revokedAt}`), w)] : []),
              ...describeGrant(pick.namespaces, pick.capabilities).map((g) =>
                truncateCells(clean(`    ${g}`), w)
              ),
              '  backspace back · esc close'
            ];
            return linesView([headLine, ...detail.map((text): Line => ({ text }))], theme);
          }
          const all = listLines(state.rows, w);
          // Head, legend and hints take three rows.
          const max = Math.max(1, size.rows - 3);
          const at = Math.max(
            0,
            all.findIndex((l) => l.row === state.cursor)
          );
          const start = Math.max(0, Math.min(at - max + 1, all.length - max));
          const lines = all
            .slice(start, start + max)
            .map(
              (l): Line =>
                partsLine(
                  l.row !== undefined && l.row === state.cursor
                    ? selectLine(l, theme.glyph.cursor, w)
                    : l.parts
                )
            );
          // 'r show revoked' is one key and its action, so the toggle's key is the lone `r`.
          const toggle = state.revoked ? 'hide revoked' : 'show revoked';
          const hints: [string, string][] =
            state.source === 'admin' && deps.admin.unlocked()
              ? [
                  ['↑↓/jk', 'move'],
                  ['enter', 'edit'],
                  ['x', 'revoke'],
                  ['i', 'invite'],
                  ['n', 'register'],
                  ['r', toggle],
                  ['esc', 'close']
                ]
              : [
                  ['↑↓/jk', 'move'],
                  ['enter', 'grant'],
                  ['r', toggle],
                  ['esc', 'close']
                ];
          return linesView(
            [
              headLine,
              ...lines,
              partsLine(truncateParts(legendParts(), w)),
              partsLine(truncateParts(hintParts(hints), w))
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
            const showingCode = p === 'review' && 'inviteToken' in x && x.inviteToken !== undefined;
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
