/**
 * The `/keys` grant editor: the matrix (`edit`), a text prompt (`prompt`) and the
 * review (`review`). Each stage that takes typed text is its own panel, because a panel's keymap
 * wins over the draft (surface-core keys.ts).
 */

import { readFile } from 'node:fs/promises';
import type { AdminKeyAlgorithm, AdminKeyRow, Grant } from '@mnmal-ai/substrate/client';
import { type ModuleCtx, type PanelDef, sanitise } from '@mnmal-ai/surface-core';
import { truncateCells } from '@mnmal-ai/surface-kit';
import { refusalOf } from '../admin/refusal.js';
import { adminCapabilityOf } from '../admin/session.js';
import type { TuiDeps } from '../deps.js';
import { linesView, type Line as Toned } from '../lines.js';
import { compactGrant, hostedNamespaces, rowGrant, toWire } from './grant.js';
import {
  addNamespace,
  CAPS,
  type Cell,
  cell,
  changed,
  type Matrix,
  move,
  openMatrix,
  result,
  toggle
} from './matrix.js';
import type { KeysPanels } from './module.js';
import { loadKeys } from './module.js';
import { expandHome, readPublicKey } from './pubkey.js';
import { type Flag, newKeyVerdict, revokeVerdict, updateVerdict, type Verdict } from './verdict.js';

export type Flow =
  | { readonly kind: 'update'; readonly row: AdminKeyRow }
  | {
      readonly kind: 'register';
      readonly kid: string;
      readonly publicKey: string;
      readonly algorithm: AdminKeyAlgorithm;
      readonly fingerprint: string;
      readonly name?: string;
    }
  | { readonly kind: 'invite' }
  | { readonly kind: 'revoke'; readonly row: AdminKeyRow };

export interface EditState {
  readonly flow: Exclude<Flow, { kind: 'revoke' }>;
  readonly matrix: Matrix;
  readonly table: readonly AdminKeyRow[];
  readonly discardArmed: boolean;
  readonly note: string | null;
}

export type PromptPurpose = 'add-ns' | 'reg-kid' | 'reg-pubkey' | 'reg-name' | 'invite-ttl';
export interface PromptState {
  readonly purpose: PromptPurpose;
  readonly label: string;
  readonly error: string | null;
  /** The editor to return to (add-ns, invite-ttl), or null for the register prompts before it. */
  readonly back: EditState | null;
  /** Register answers gathered so far. */
  readonly kid?: string;
  /** Exactly as read from the file: the server hashes the body as received. */
  readonly publicKey?: string;
  readonly algorithm?: AdminKeyAlgorithm;
  readonly fingerprint?: string;
  readonly table: readonly AdminKeyRow[];
}

/** Parses `30m`, `12h`, `7d`; '' is the server default (undefined). Null when unreadable. */
export function parseTtl(text: string): number | undefined | null {
  const t = text.trim();
  if (t === '') return undefined;
  const m = /^(\d+)\s*([mhd])$/.exec(t);
  if (m === null) return null;
  const n = Number(m[1]);
  return n > 0 ? n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'] : null;
}

/** The invites route's ceiling (substrate-compose `_system/routes/shared.ts` MAX_TTL_MS): 30 days. */
const MAX_INVITE_TTL_MS = 30 * 86_400_000;

/** The invite-ttl prompt's reading: a ttl (absent for the server default), or why not. */
export function readInviteTtl(text: string): { ttlMs?: number } | { error: string } {
  const ttlMs = parseTtl(text);
  if (ttlMs === null) return { error: 'a duration like 30m, 12h or 7d' };
  if (ttlMs === undefined) return {};
  return ttlMs > MAX_INVITE_TTL_MS ? { error: 'at most 30 days' } : { ttlMs };
}

const NS_NAME = /^(\*|[A-Za-z0-9_.-]+)$/;

/** A panel line: plain, or a refusal that renders in the theme's error tone. */
export type Line = string | { readonly error: string };
const refusal = (text: string): Line => ({ error: text });

/** As the shared toned lines: a refusal in the error tone, anything else untoned. */
const toned = (lines: readonly Line[]): Toned[] =>
  lines.map((l) => (typeof l === 'string' ? { text: l } : { text: l.error, tone: 'error' }));

function promptView(s: PromptState, glyph: { title: string }): Line[] {
  return [
    `${glyph.title} keys › ${sanitise(s.label)}`,
    ...(s.kid !== undefined ? [`  ${sanitise(s.kid)}`] : []),
    ...(s.algorithm !== undefined && s.fingerprint !== undefined
      ? [`  ${s.algorithm} · ${s.fingerprint}`]
      : []),
    ...(s.error !== null ? [refusal(`  ${sanitise(s.error)}`)] : []),
    '  enter accept · esc back'
  ];
}

export interface ReviewState {
  readonly flow: Flow;
  /** The editor to return to; null for revoke, which has none. */
  readonly edit: EditState | null;
  readonly next: Grant | null;
  readonly verdict: Verdict;
  readonly ttlMs?: number;
  readonly stage: 'review' | 'applying' | 'done' | 'refused';
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly mismatch: boolean;
  /** Why a refused review's state could not be refreshed, or what the refresh found (the kid is gone). */
  readonly refreshNote?: string;
  /** Set only for an applied invite: shown in this panel, never printed. */
  readonly inviteCode?: string;
  readonly table: readonly AdminKeyRow[];
}

/** What the tier-2 gesture asks to be typed: the kid, or the word `invite`. Never pre-filled. */
export function targetOf(flow: Flow): string {
  switch (flow.kind) {
    case 'update':
    case 'revoke':
      return flow.row.kid;
    case 'register':
      return flow.kid;
    case 'invite':
      return 'invite';
  }
}

const EMPTY_NOTE = 'a key needs at least one namespace — revoke removes all access';

/** The request's verdict, judged on exactly what apply will send. */
function verdictOf(deps: TuiDeps, s: EditState, next: Grant): Verdict {
  const hosted = [...s.matrix.hosted];
  // The TUI's reading of SUBSTRATE_ADMIN_CAPABILITY only previews. The server's is authoritative, and a
  // mismatch surfaces as its own refusal, shown verbatim: the preview fails safe.
  const adminCapability = adminCapabilityOf(deps.adminEnv).adminCapability ?? 'admin';
  return s.flow.kind === 'update'
    ? updateVerdict({ row: s.flow.row, next, table: s.table, hosted, adminCapability })
    : newKeyVerdict({ kind: s.flow.kind, next, hosted, adminCapability });
}

function reviewOf(s: EditState, next: Grant, verdict: Verdict, ttlMs?: number): ReviewState {
  return {
    flow: s.flow,
    edit: s,
    next,
    verdict,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    stage: 'review',
    error: null,
    mismatch: false,
    table: s.table
  };
}

function ttlText(ms: number): string {
  for (const [unit, n] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000]
  ] as const) {
    if (ms % n === 0) return `${ms / n}${unit}`;
  }
  return `${ms}ms`;
}

const entry = (ns: string, caps: ReadonlySet<string>) => compactGrant(ns, [...caps].join(','));

/** One line per namespace whose entry changed: removed (−), added (+), or both for a change. */
function diffLines(before: Grant, after: Grant): string[] {
  const out: string[] = [];
  for (const ns of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(ns);
    const b = after.get(ns);
    const same =
      a !== undefined && b !== undefined && a.size === b.size && [...a].every((c) => b.has(c));
    if (same) continue;
    if (a !== undefined && a.size > 0) out.push(`  − ${entry(ns, a)}`);
    if (b !== undefined && b.size > 0) out.push(`  + ${entry(ns, b)}`);
  }
  return out;
}

/** `  code <chunk>` then `  | <chunk>` lines, each at most `width` cells; nothing is dropped. */
export function wrapCode(code: string, width: number): string[] {
  const first = '  code ';
  const next = '  | ';
  const out: string[] = [];
  // Code points, not UTF-16 units: a slice must not split a surrogate pair.
  let rest = Array.from(code);
  let prefix = first;
  do {
    const room = Math.max(1, width - prefix.length);
    out.push(prefix + rest.slice(0, room).join(''));
    rest = rest.slice(room);
    prefix = next;
  } while (rest.length > 0);
  return out;
}

function reviewView(
  s: ReviewState,
  glyph: { title: string },
  armed: { key: string; label: string } | undefined,
  size: { columns: number }
): Line[] {
  const w = Math.max(1, size.columns - 2);
  const fit = (line: string) => truncateCells(sanitise(line), w);
  const f = s.flow;
  const target = targetOf(f);
  const next = s.next ?? new Map();
  const body: string[] = [];
  switch (f.kind) {
    case 'update':
      body.push(
        `  before ${compactGrant(f.row.namespaces, f.row.capabilities)}`,
        `  after  ${grantLine(next)}`,
        ...diffLines(rowGrant(f.row) ?? new Map(), next)
      );
      break;
    case 'register':
      body.push(
        `  register ${f.kid} · ${f.algorithm} · ${f.fingerprint}`,
        `  grant ${grantLine(next)}`
      );
      break;
    case 'invite':
      body.push(
        `  invite for ${grantLine(next)}`,
        `  expires in ${s.ttlMs !== undefined ? ttlText(s.ttlMs) : 'the server default'}`
      );
      break;
    case 'revoke':
      body.push(`  ${f.row.kid} loses access immediately`);
      break;
  }
  const v = s.verdict;
  const verdict: Line[] =
    v.kind === 'refused'
      ? [refusal(`  refused: ${v.code}: ${v.message}`)]
      : v.reasons.map((r) => `  · ${r}`);
  let tail: Line[];
  switch (s.stage) {
    case 'review':
      tail =
        v.kind === 'refused'
          ? ['  esc back']
          : v.tier === 1
            ? [
                armed !== undefined
                  ? `  ${armed.key} — ${armed.label} · enter confirms · esc back`
                  : '  y then enter applies · esc back'
              ]
            : [
                `  type ${target} then enter to apply · esc back`,
                ...(s.mismatch ? ['  does not match'] : [])
              ];
      break;
    case 'applying':
      tail = ['  applying…'];
      break;
    case 'refused':
      tail = [
        refusal(`  ${s.error?.code ?? 'error'}: ${s.error?.message ?? ''}`),
        ...(s.refreshNote !== undefined ? [refusal(`  ${s.refreshNote}`)] : []),
        '  esc back'
      ];
      break;
    case 'done':
      tail =
        s.inviteCode !== undefined
          ? [
              // Never truncated: a clipped code is a useless code. Wrapped to fit instead.
              ...wrapCode(sanitise(s.inviteCode), w),
              '  give it to the invitee; it is not shown again',
              '  esc close'
            ]
          : ['  esc close'];
      break;
  }
  const head = fit(`${glyph.title} keys › ${target} · review`);
  const fitLine = (l: Line): Line => (typeof l === 'string' ? fit(l) : refusal(fit(l.error)));
  return [
    head,
    ...body.map(fit),
    ...verdict.map(fitLine),
    ...tail.map((l) =>
      typeof l === 'string' && (l.startsWith('  code ') || l.startsWith('  | ')) ? l : fitLine(l)
    )
  ];
}

/** The 422 refusals a verdict can predict and a stale table can get wrong (verdict.ts). */
const CONFIRMABLE: ReadonlySet<string> = new Set([
  'requires_widen',
  'requires_allow_admin',
  'unknown_namespaces'
]);

export type EditorPanels = { edit: EditState; prompt: PromptState; review: ReviewState };
type Ctx = ModuleCtx<KeysPanels>;

/** Every panel it opens is an admin panel, so it opens nothing once the session is locked. */
export function switchTo<K extends keyof KeysPanels & string>(
  ctx: Pick<Ctx, 'open'>,
  deps: { readonly admin: Pick<TuiDeps['admin'], 'unlocked'> },
  panel: K,
  state: KeysPanels[K]
): void {
  if (deps.admin.unlocked()) ctx.open(panel, state);
}

/** Opens the matrix for a flow; reads the hosted namespaces first. */
export async function openEditor(
  ctx: Ctx,
  deps: TuiDeps,
  flow: EditState['flow'],
  table: readonly AdminKeyRow[],
  /** The panel this was launched from; it must still be the open one when the read lands. */
  from: 'keys' | 'prompt' = 'keys'
): Promise<void> {
  const subject =
    flow.kind === 'invite' ? 'new invite' : flow.kind === 'update' ? flow.row.kid : flow.kid;
  let hosted: string[];
  try {
    hosted = hostedNamespaces(await deps.federatedSchema());
  } catch (err) {
    ctx.print(
      `cannot edit ${subject}: could not read the hosted namespaces: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
    return;
  }
  // The read awaited: a lock, or a panel change, during it means this open is no longer wanted.
  let stillThere = false;
  ctx.update(from, (cur) => {
    stillThere = true;
    return cur;
  });
  if (!stillThere || !deps.admin.unlocked()) return;
  let before: Grant = new Map();
  if (flow.kind === 'update') {
    const parsed = rowGrant(flow.row);
    if (parsed === null) {
      ctx.print(`cannot edit ${flow.row.kid}: its stored grant does not parse`, 'error');
      return;
    }
    before = parsed;
  }
  ctx.setDraft('');
  ctx.open('edit', {
    flow,
    matrix: openMatrix(before, hosted),
    table,
    discardArmed: false,
    note: null
  });
}

const GLYPH: Readonly<Record<Cell['held'], string>> = { on: '■', inherited: '◆', off: '□' };
const DIFF: Readonly<Record<Cell['diff'], string>> = { '+': '+', '-': '−', '': ' ' };

function grantLine(g: Grant): string {
  const wire = toWire(g);
  return wire.namespaces.length === 0
    ? '(none)'
    : compactGrant(wire.namespaces.join(','), wire.capabilities.join(','));
}

function editView(
  s: EditState,
  glyph: { title: string; cursor: string },
  size: { columns: number; rows: number }
): Line[] {
  const w = Math.max(1, size.columns - 2);
  const fit = (line: string) => truncateCells(sanitise(line), w);
  const m = s.matrix;
  const f = s.flow;
  const subject = f.kind === 'invite' ? 'new invite' : f.kind === 'update' ? f.row.kid : f.kid;
  const label = (ns: string) => (ns === '*' ? '* every namespace' : ns);
  const nsW = Math.min(
    24,
    Math.max('namespace'.length, ...m.rows.map((ns) => label(ns).length)) + 2
  );
  const granted = result(m);
  const visible = Math.max(1, size.rows - 6);
  const start = Math.max(0, Math.min(m.row - visible + 1, m.rows.length - visible));
  const grid = m.rows.slice(start, start + visible).map((ns, k) => {
    const at = start + k === m.row;
    const cells = CAPS.map((cap, c) => {
      const x = cell(m, ns, cap);
      const text = `${GLYPH[x.held]}${DIFF[x.diff]}`;
      // A string view has no tone, so the cursor cell is bracketed instead of accented. Every cell
      // is four wide with the glyph at offset 1, so the brackets replace the padding, not shift it.
      return at && c === m.col ? `[${text}]` : ` ${text} `;
    }).join('');
    const tail =
      ns !== '*' && !m.hosted.has(ns)
        ? '  unhosted'
        : m.hosted.has(ns) && !granted.has(ns)
          ? '  (hosted, not granted)'
          : '';
    const name = truncateCells(label(ns), nsW - 2).padEnd(nsW);
    // Cells keep their padding so the tail starts in one column on every row.
    return fit(`${at ? glyph.cursor : ' '} ${name}${cells}${tail}`.trimEnd());
  });
  const before =
    f.kind === 'update' ? compactGrant(f.row.namespaces, f.row.capabilities) : '(none)';
  const foot: Line[] =
    s.note !== null
      ? [s.note === EMPTY_NOTE ? refusal(fit(`  ${s.note}`)) : fit(`  ${s.note}`)]
      : s.discardArmed
        ? ['  discard changes? esc again']
        : [];
  return [
    fit(`${glyph.title} keys › ${subject} · editing`),
    fit(`  ${'namespace'.padEnd(nsW)} r   m   a`),
    ...grid,
    fit(`  before ${before}`),
    fit(`  after  ${grantLine(granted)}`),
    ...foot,
    fit('  ↑↓←→ move · space toggle · + add namespace · enter review · esc discard')
  ];
}

export function editorPanels(deps: TuiDeps): {
  [K in keyof EditorPanels]: PanelDef<EditorPanels[K], KeysPanels>;
} {
  const act =
    (fn: (s: EditState, ctx: Ctx) => EditState | undefined) =>
    (s: EditState, ctx: Ctx): EditState | undefined => {
      ctx.setDraft('');
      return fn({ ...s, discardArmed: false, note: null }, ctx);
    };
  const step = (dRow: number, dCol: number) =>
    act((s) => ({ ...s, matrix: move(s.matrix, dRow, dCol) }));

  return {
    edit: {
      view: ({ state, theme, size }) => linesView(toned(editView(state, theme.glyph, size)), theme),
      keymap: [
        { key: 'up', act: 'up' },
        { key: 'down', act: 'down' },
        { key: 'left', act: 'left' },
        { key: 'right', act: 'right' },
        { key: ' ', act: 'toggle' },
        { key: '+', act: 'add' },
        { key: 'enter', act: 'review' }
      ],
      on: {
        up: step(-1, 0),
        down: step(1, 0),
        left: step(0, -1),
        right: step(0, 1),
        toggle: act((s) => ({ ...s, matrix: toggle(s.matrix) })),
        add: act((s, ctx) => {
          switchTo(ctx, deps, 'prompt', {
            purpose: 'add-ns',
            label: 'namespace to add',
            error: null,
            back: s,
            table: s.table
          });
          return undefined;
        }),
        review: act((s, ctx) => {
          if (s.flow.kind === 'update' && !changed(s.matrix)) {
            return { ...s, note: 'no changes to review' };
          }
          const next = result(s.matrix);
          if (next.size === 0) return { ...s, note: EMPTY_NOTE };
          if (s.flow.kind === 'invite') {
            switchTo(ctx, deps, 'prompt', {
              purpose: 'invite-ttl',
              label: 'expires in (e.g. 30m, 12h, 7d; enter for the server default)',
              error: null,
              back: s,
              table: s.table
            });
            return undefined;
          }
          switchTo(ctx, deps, 'review', reviewOf(s, next, verdictOf(deps, s, next)));
          return undefined;
        })
      },
      // Declared only so `escape` is consulted: surface-core asks it only of a panel with `submit`.
      submit: () => undefined,
      escape: (s) =>
        changed(s.matrix) && !s.discardArmed ? { ...s, discardArmed: true } : undefined
    },
    prompt: {
      view: ({ state, theme }) => linesView(toned(promptView(state, theme.glyph)), theme),
      submit: (s, line, ctx) => {
        const text = line.trim();
        switch (s.purpose) {
          case 'add-ns': {
            if (s.back === null) return undefined;
            if (!NS_NAME.test(text)) {
              return { ...s, error: 'a namespace is letters, digits, _ . - or *' };
            }
            switchTo(ctx, deps, 'edit', {
              ...s.back,
              matrix: addNamespace(s.back.matrix, text),
              discardArmed: false,
              note: null
            });
            return undefined;
          }
          case 'reg-kid': {
            if (text === '') return { ...s, error: 'a kid is required' };
            if (s.table.some((r) => r.kid === text)) {
              return { ...s, error: `${text} is already live — revoke it first` };
            }
            return {
              ...s,
              purpose: 'reg-pubkey',
              label: 'public key path',
              kid: text,
              error: null
            };
          }
          case 'reg-pubkey': {
            const expanded = expandHome(text);
            if ('error' in expanded) return { ...s, error: expanded.error };
            const path = expanded.path;
            const kid = s.kid;
            void readFile(path, 'utf8').then(
              (pem) => {
                const read = readPublicKey(pem);
                ctx.update('prompt', (cur) =>
                  cur.purpose !== 'reg-pubkey' || cur.kid !== kid
                    ? cur
                    : read.ok
                      ? {
                          ...cur,
                          purpose: 'reg-name',
                          label: 'name (enter for none)',
                          publicKey: pem,
                          algorithm: read.algorithm,
                          fingerprint: read.fingerprint,
                          error: null
                        }
                      : { ...cur, error: read.reason }
                );
              },
              (err: unknown) => {
                const code = (err as { code?: unknown }).code;
                const why = typeof code === 'string' ? code : 'unreadable';
                ctx.update('prompt', (cur) =>
                  cur.purpose !== 'reg-pubkey' || cur.kid !== kid
                    ? cur
                    : { ...cur, error: `cannot read ${path}: ${why}` }
                );
              }
            );
            return { ...s, error: null };
          }
          case 'reg-name': {
            if (
              s.kid === undefined ||
              s.publicKey === undefined ||
              s.algorithm === undefined ||
              s.fingerprint === undefined
            ) {
              return undefined;
            }
            void openEditor(
              ctx,
              deps,
              {
                kind: 'register',
                kid: s.kid,
                publicKey: s.publicKey,
                algorithm: s.algorithm,
                fingerprint: s.fingerprint,
                ...(text !== '' ? { name: text } : {})
              },
              s.table,
              'prompt'
            );
            return undefined;
          }
          case 'invite-ttl': {
            if (s.back === null) return undefined;
            const ttl = readInviteTtl(line);
            if ('error' in ttl) return { ...s, error: ttl.error };
            const next = result(s.back.matrix);
            switchTo(
              ctx,
              deps,
              'review',
              reviewOf(s.back, next, verdictOf(deps, s.back, next), ttl.ttlMs)
            );
            return undefined;
          }
        }
      },
      escape: (s, ctx) => {
        if (s.back !== null) switchTo(ctx, deps, 'edit', s.back);
        else void loadKeys(ctx, deps);
        return undefined;
      }
    },
    review: {
      view: ({ state, theme, armed, size }) =>
        linesView(toned(reviewView(state, theme.glyph, armed, size)), theme),
      confirm: [{ key: 'y', act: 'apply', label: 'applies this change' }],
      on: {
        apply: (s, ctx) =>
          s.stage === 'review' && s.verdict.kind === 'ok' && s.verdict.tier === 1
            ? apply(s, ctx)
            : undefined
      },
      submit: (s, line, ctx) => {
        if (!(s.stage === 'review' && s.verdict.kind === 'ok' && s.verdict.tier === 2)) {
          return undefined;
        }
        return line === targetOf(s.flow) ? apply(s, ctx) : { ...s, mismatch: true };
      },
      escape: (s, ctx) => {
        if (s.stage === 'applying') return s;
        if (s.stage !== 'done' && s.edit !== null) switchTo(ctx, deps, 'edit', s.edit);
        else void loadKeys(ctx, deps);
        return undefined;
      }
    }
  };

  /** After a confirmable 422 the verdict was judged on state the server no longer holds: the key's
   *  row, the key table or the hosted set. Re-reads the table and the hosted namespaces, swaps the
   *  fresh row into the flow and the editor it returns to, and recomputes the verdict, so the next
   *  review (Esc, Enter) shows the real tier and flags. The refusal stays visible; nothing is sent. */
  async function refreshReview(ctx: Ctx, at: ReviewState): Promise<void> {
    let rows: AdminKeyRow[];
    let hosted: string[];
    try {
      rows = await deps.admin.run(({ client }) => client.admin.keys({ signal: ctx.signal }));
      hosted = hostedNamespaces(await deps.federatedSchema());
    } catch {
      ctx.update('review', (x) =>
        x.flow === at.flow && x.stage === 'refused'
          ? {
              ...x,
              refreshNote:
                'could not refresh the key table or hosted namespaces — esc back, then reopen it'
            }
          : x
      );
      return;
    }
    // The reads awaited: only into this same review, and only while still unlocked.
    if (!deps.admin.unlocked()) return;
    ctx.update('review', (x) => {
      if (x.flow !== at.flow || x.stage !== 'refused') return x;
      const f = x.flow;
      // `edit: null` sends esc back to the table: the editor holds the stale row.
      const gone = (kid: string): ReviewState => ({
        ...x,
        edit: null,
        table: rows,
        mismatch: false,
        refreshNote: `${kid} is no longer in the key table — esc back and reopen it`,
        verdict: {
          kind: 'refused',
          code: 'not_found',
          message: `${kid} is no longer in the key table`
        }
      });
      if (f.kind === 'revoke') {
        const row = rows.find((r) => r.kid === f.row.kid);
        return row === undefined
          ? gone(f.row.kid)
          : {
              ...x,
              flow: { kind: 'revoke', row },
              table: rows,
              verdict: revokeVerdict({
                kid: row.kid,
                table: rows,
                adminCapability: adminCapabilityOf(deps.adminEnv).adminCapability ?? 'admin'
              })
            };
      }
      if (x.edit === null || x.next === null) return x;
      let flow = x.edit.flow;
      let matrix: Matrix = { ...x.edit.matrix, hosted: new Set(hosted) };
      if (flow.kind === 'update') {
        const row = rows.find((r) => r.kid === (flow as { row: AdminKeyRow }).row.kid);
        if (row === undefined) return gone(flow.row.kid);
        const before = rowGrant(row);
        if (before === null) {
          return {
            ...x,
            edit: null,
            table: rows,
            refreshNote: `${row.kid}: its stored grant does not parse — esc back and reopen it`,
            verdict: {
              kind: 'refused',
              code: 'unparseable_grant',
              message: 'stored grant does not parse'
            }
          };
        }
        flow = { kind: 'update', row };
        // Namespaces the fresh grant holds that the editor lacks get rows, so the diff shows them.
        const extra = [...before.keys()].filter((ns) => !matrix.rows.includes(ns));
        matrix = { ...matrix, before, rows: [...matrix.rows, ...extra] };
      }
      const edit: EditState = { ...x.edit, flow, matrix, table: rows };
      return {
        ...x,
        flow,
        edit,
        table: rows,
        mismatch: false,
        verdict: verdictOf(deps, edit, x.next)
      };
    });
  }

  /** Sends exactly what the verdict judged, with only the flags it named; the result lands through `ctx.update`. */
  function apply(s: ReviewState, ctx: Ctx): ReviewState {
    const v = s.verdict;
    if (v.kind !== 'ok') return s;
    const flag = (f: Flag) => (v.flags.includes(f) ? { [f]: true } : {});
    const f = s.flow;
    // Read before the request: a lock landing mid-request must not turn the attribution unknown.
    const st = deps.admin.state();
    const who = st.kind === 'unlocked' ? st.kid : 'unknown';
    void deps.admin
      .run(async ({ client }): Promise<{ line: string; select?: string; code?: string }> => {
        if (f.kind === 'revoke') {
          await client.admin.revoke(f.row.kid);
          return { line: `✓ revoked ${f.row.kid}` };
        }
        const w = toWire(s.next ?? new Map());
        const shown = compactGrant(w.namespaces.join(','), w.capabilities.join(','));
        if (f.kind === 'update') {
          await client.admin.update({
            kid: f.row.kid,
            ...w,
            ...flag('widen'),
            ...flag('allowAdmin'),
            ...flag('allowUnknownNs')
          });
          return { line: `✓ granted ${f.row.kid} ${shown}`, select: f.row.kid };
        }
        if (f.kind === 'register') {
          // The PEM as read: the server fingerprints the body it receives.
          const out = await client.admin.register({
            kid: f.kid,
            publicKey: f.publicKey,
            algorithm: f.algorithm,
            ...(f.name !== undefined ? { name: f.name } : {}),
            ...w,
            ...flag('allowAdmin'),
            ...flag('allowUnknownNs')
          });
          return { line: `✓ registered ${f.kid} ${shown} ${out.fingerprint}`, select: f.kid };
        }
        const out = await client.admin.invite({
          ...w,
          ...(s.ttlMs !== undefined ? { ttlMs: s.ttlMs } : {})
        });
        return { line: `✓ invite minted for ${shown}, expires ${out.expiresAt}`, code: out.code };
      })
      .then(
        (r) => {
          // The code stays out of this line: the transcript outlives the panel.
          ctx.print(sanitise(`${r.line} (admin: ${who})`), 'ok');
          let open = false;
          ctx.update('review', (x) => {
            open = true;
            return r.code !== undefined
              ? { ...x, stage: 'done', inviteCode: r.code }
              : { ...x, stage: 'done' };
          });
          // Re-read only into the panel this apply came from, and only while still unlocked.
          if (open && r.code === undefined && deps.admin.unlocked()) {
            void loadKeys(ctx, deps, r.select);
          }
        },
        (err: unknown) => {
          // A rejected admin key has already locked the session inside admin.run, and the lock
          // closed this panel; the refusal then goes to the transcript so it is not lost.
          const error = refusalOf(err);
          let open = false;
          ctx.update('review', (x) => {
            open = true;
            return { ...x, stage: 'refused', error };
          });
          if (!open) ctx.print(`${error.code}: ${error.message}`, 'error');
          else if (CONFIRMABLE.has(error.code)) void refreshReview(ctx, s);
        }
      );
    return { ...s, stage: 'applying' };
  }
}
