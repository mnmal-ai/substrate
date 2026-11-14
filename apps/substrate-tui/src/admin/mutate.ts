/**
 * `/admin mutate`: a raw mutate frame, previewed, confirmed by typing its keys, then sent signed
 * as the admin identity. Generic on purpose: nothing here knows any namespace's types, so the
 * preview describes the frame's shape and the server is the only judge of what it means.
 */

import type { QualifiedFrame } from '@mnmal-ai/substrate/client';
import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import { sanitise } from '@mnmal-ai/surface-core';
import type { Line } from '../lines.js';

const KEY = /^[A-Za-z_][\w-]*\/[A-Za-z_]\w*$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const line = (text: string, tone?: Line['tone']): Line => ({
  text: sanitise(text),
  ...(tone !== undefined ? { tone } : {})
});

/** JSON, one Line per printed line: what was sent or received, verbatim. */
export const jsonLines = (v: unknown, tone?: Line['tone']): Line[] =>
  JSON.stringify(v, null, 2)
    .split('\n')
    .map((t) => line(`  ${t}`, tone));

/** The typed text, parsed into a frame whose every key is `<ns>/<mutation>`, or why not. */
export function parseMutateFrame(
  text: string
): { readonly frame: QualifiedFrame } | { readonly error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    return { error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObject(v) || Object.keys(v).length === 0) {
    return {
      error: 'a mutate frame is a non-empty object: { "<ns>/<mutation>": { "params": … } }'
    };
  }
  for (const [k, entry] of Object.entries(v)) {
    if (!KEY.test(k)) return { error: `'${k}' is not a qualified <ns>/<mutation> key` };
    const entries = Array.isArray(entry) ? entry : [entry];
    if (entries.length === 0) return { error: `'${k}' is an empty batch` };
    if (!entries.every(isObject)) {
      return { error: `'${k}' must be a { params, fields } object or an array of them` };
    }
  }
  return { frame: v as QualifiedFrame };
}

/** The text the operator types to send it: the frame's keys, space-separated. */
export const confirmOf = (frame: QualifiedFrame): string => Object.keys(frame).join(' ');

/** A dry description: which mutation, how many entries, which ids and which params. Sends nothing. */
export function describeMutate(frame: QualifiedFrame, kid: string): Line[] {
  const out: Line[] = [];
  for (const [k, entry] of Object.entries(frame)) {
    const entries = Array.isArray(entry) ? entry : [entry];
    out.push(
      line(
        `${k} · ${entries.length === 1 ? '1 entry' : `${entries.length} entries, one transaction`}`
      )
    );
    for (const e of entries) {
      const params = isObject(e.params) ? e.params : {};
      const id = params.id;
      const rest = Object.keys(params).filter((p) => p !== 'id');
      out.push(
        line(
          `  ${id !== undefined ? `row ${String(id)}` : 'no id'} · ${rest.length > 0 ? `params ${rest.join(', ')}` : 'no other params'}`,
          'dim'
        )
      );
    }
  }
  out.push(line(`signed as admin ${kid}; nothing has been sent`, 'warn'));
  out.push(line('frame:'), ...jsonLines(frame, 'dim'));
  return out;
}

/** The envelope as received: `errors` first, then each asked-for key absent from `data`, then `data`. */
export function envelopeLines(
  frame: QualifiedFrame,
  env: PackEnvelope
): {
  lines: Line[];
  ok: boolean;
} {
  const errors = env.errors ?? [];
  const data = env.data ?? {};
  // A refused key is absent from `data`, not empty: presence is the signal.
  const absent = Object.keys(frame).filter((k) => !(k in data));
  const lines: Line[] = [];
  if (errors.length > 0) lines.push(line('errors:', 'error'), ...jsonLines(errors, 'error'));
  for (const k of absent) lines.push(line(`${k}: absent from data — not applied`, 'error'));
  lines.push(line('data:'), ...jsonLines(data));
  return { lines, ok: errors.length === 0 && absent.length === 0 };
}
