/**
 * Sketch text to `ActStep[]`, and back. Pure: no registry, no coercion. Every
 * value stays a string (or a list of strings) except bare `null`.
 */

import type { ActRefusal, ActStep, ActValue } from '@mnmal-ai/substrate-types';

export type ParsedSketch = { steps: ActStep[]; texts: string[] } | { refusal: ActRefusal };

interface Elem {
  v: string;
  quoted: boolean;
}
interface Tok {
  raw: string;
  /** Set when the token is `key=value`. */
  key: string | null;
  /** One element, or several when the value had an unquoted comma. */
  elems: Elem[];
}

const ACTION = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPE = /^([A-Za-z_][A-Za-z0-9_]*\/)?[A-Za-z_][A-Za-z0-9_]*$/;
/** `define` names the word after its type: `Todo.reopen`. */
const DEFINE_TYPE = /^([A-Za-z_][A-Za-z0-9_]*\/)?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$/;
/** A step reference: `#N`, `$name`, or a full id. */
export const REF = /^(#\d+|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9_.:-]+)$/;
const BINDING = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const NEEDS_QUOTES = /[\s;,"=#$\\[\]]/;

const refuse = (step: number, token: string, problem: string): { refusal: ActRefusal } => ({
  refusal: { code: 'sketch_unresolved', step, token, problem, choices: [], nearest: null }
});

/** Reads a quoted run starting after the opening quote; returns the text and the index past the closing quote, or null when unterminated. */
function readQuoted(text: string, from: number): { value: string; end: number } | null {
  let value = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { value, end: i + 1 };
    if (c === '\\' && i + 1 < text.length) {
      const n = text[++i];
      value += n === 'n' ? '\n' : n === '"' || n === '\\' ? n : `\\${n}`;
    } else value += c;
  }
  return null;
}

/** Splits on `;` or newline outside quotes, dropping blank steps. */
function splitSteps(text: string): { steps: string[] } | { unterminated: number; token: string } {
  const steps: string[] = [];
  let start = 0;
  const push = (end: number) => {
    const s = text.slice(start, end).trim();
    if (s) steps.push(s);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const q = readQuoted(text, i + 1);
      if (!q) return { unterminated: steps.length + 1, token: text.slice(i).trim() };
      i = q.end - 1;
    } else if (c === ';' || c === '\n') {
      push(i);
      start = i + 1;
    }
  }
  push(text.length);
  return { steps };
}

/** Splits one step on whitespace outside quotes. Quotes are balanced by `splitSteps`. */
function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i] as string)) {
      i++;
      continue;
    }
    const start = i;
    const tok: Tok = { raw: '', key: null, elems: [] };
    let cur = '';
    let quoted = false;
    while (i < text.length && !/\s/.test(text[i] as string)) {
      const c = text[i] as string;
      if (c === '"') {
        const q = readQuoted(text, i + 1) as { value: string; end: number };
        cur += q.value;
        quoted = true;
        i = q.end;
        continue;
      }
      if (c === ',') {
        tok.elems.push({ v: cur, quoted });
        cur = '';
        quoted = false;
      } else if (c === '=' && tok.key === null && tok.elems.length === 0 && !quoted && cur !== '') {
        tok.key = cur;
        cur = '';
      } else cur += c;
      i++;
    }
    tok.elems.push({ v: cur, quoted });
    tok.raw = text.slice(start, i);
    toks.push(tok);
  }
  return toks;
}

/** `raw` is the value as written: `[a,b]`, `[a]` and `[]` are lists whatever their length. */
function argValue(elems: Elem[], raw: string): ActValue {
  const [first] = elems as [Elem];
  if (raw.length > 1 && raw.startsWith('[') && raw.endsWith(']')) {
    const vs = elems.map((e) => e.v);
    vs[0] = (vs[0] as string).slice(1);
    vs[vs.length - 1] = (vs.at(-1) as string).slice(0, -1);
    return vs.length === 1 && vs[0] === '' ? [] : vs;
  }
  if (elems.length > 1) return elems.map((e) => e.v);
  return !first.quoted && first.v === 'null' ? null : first.v;
}

/** A bare reference, or a list of them written `#1,#2` or `[#1,#2]`; null when the token is anything else. */
function refList(t: Tok): string[] | null {
  if (t.key !== null || t.elems.some((e) => e.quoted)) return null;
  const vs = t.elems.map((e) => e.v);
  if (t.raw.length > 1 && t.raw.startsWith('[') && t.raw.endsWith(']')) {
    vs[0] = (vs[0] as string).slice(1);
    vs[vs.length - 1] = (vs.at(-1) as string).slice(0, -1);
  }
  return vs.every((v) => REF.test(v)) ? vs : null;
}

function parseStep(text: string, n: number): ActStep | { refusal: ActRefusal } {
  const toks = tokenize(text);
  const [head, second] = toks as [Tok, Tok | undefined];
  const plain = (t: Tok) => t.key === null && t.elems.length === 1 && !(t.elems[0] as Elem).quoted;
  const word = (t: Tok) => (t.elems[0] as Elem).v;

  if (!plain(head) || (word(head) !== '?' && !ACTION.test(word(head)))) {
    return refuse(n, head.raw, 'bad action');
  }
  if (word(head) === '?') {
    if (toks.length > 2) return refuse(n, (toks[2] as Tok).raw, 'help takes at most a type');
    return second ? { action: '?', type: second.raw } : { action: '?' };
  }
  if (
    !second ||
    !plain(second) ||
    !(word(head) === 'define' ? DEFINE_TYPE : TYPE).test(word(second))
  ) {
    return refuse(n, second?.raw ?? head.raw, 'missing type');
  }

  const step: ActStep = { action: word(head), type: word(second) };
  const rest = toks.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] as Tok;
    if (t.key !== null) {
      step.args ??= {};
      if (Object.hasOwn(step.args, t.key)) return refuse(n, t.raw, `duplicate arg '${t.key}'`);
      step.args[t.key] = argValue(t.elems, t.raw.slice(t.key.length + 1));
    } else if (plain(t) && word(t) === 'as') {
      const name = i === rest.length - 2 ? BINDING.exec((rest[i + 1] as Tok).raw)?.[1] : undefined;
      if (name === undefined) return refuse(n, t.raw, 'as needs $name');
      step.as = name;
      break;
    } else {
      const refs = refList(t);
      if (refs === null) return refuse(n, t.raw, 'unexpected token');
      step.refs ??= [];
      step.refs.push(...refs);
    }
  }
  return step;
}

export function parseSketch(text: string): ParsedSketch {
  const split = splitSteps(text);
  if ('unterminated' in split) return refuse(split.unterminated, split.token, 'unterminated quote');
  if (split.steps.length === 0) return refuse(1, text.trim(), 'empty sketch');
  const steps: ActStep[] = [];
  for (const [i, s] of split.steps.entries()) {
    const step = parseStep(s, i + 1);
    if ('refusal' in step) return step;
    steps.push(step);
  }
  return { steps, texts: split.steps };
}

export function formatValue(v: ActValue): string {
  if (v === null) return 'null';
  // shortcut: nested lists print as their comma join, which does not re-parse; the parser never produces them.
  if (Array.isArray(v)) {
    const joined = v.map(formatValue).join(',');
    return v.length < 2 ? `[${joined}]` : joined;
  }
  const s = String(v);
  if (s === '' || s === 'null' || NEEDS_QUOTES.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return s;
}

/** Canonical sketch text for one step; `parseSketch` reads it back to the same step. */
export function formatStep(step: ActStep): string {
  const parts = [step.action];
  if (step.type !== undefined) parts.push(step.type);
  parts.push(...(step.refs ?? []));
  for (const [k, v] of Object.entries(step.args ?? {})) parts.push(`${k}=${formatValue(v)}`);
  if (step.as !== undefined) parts.push('as', `$${step.as}`);
  return parts.join(' ');
}

export function formatSketch(steps: ActStep[]): string {
  return steps.map(formatStep).join('; ');
}
