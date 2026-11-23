/**
 * Sketch to plan. Resolves each step against the published schema and spells
 * out every frame key, param, field selection and late-bound value, or
 * refuses with the choices and the nearest valid sketch. Pure: no I/O, no
 * clock, and objects are built in a fixed order so the output is byte-stable.
 */

import {
  type ActHelp,
  type ActionDecl,
  type ActionParamDecl,
  type ActionSchema,
  type ActionSetValue,
  type ActionThenDecl,
  type ActLate,
  type ActPlan,
  type ActPlanStep,
  type ActRefusal,
  type ActStep,
  type ActValue,
  BUILT_IN_ACTIONS,
  type FieldDef,
  type Schema,
  type TypeSchema,
  toActionSchema
} from '@mnmal-ai/substrate-types';
import { clipToken, coerceValue, TOKEN_ECHO } from './coerce.js';
import { typeHelp, typesHelp } from './help.js';
import { formatSketch, formatStep, formatValue, parseSketch, REF } from './parse.js';

export interface CompileOptions {
  defaultNamespace?: string;
  /** Namespaces with a dataset that are not virtual. */
  localNamespaces: ReadonlySet<string>;
  /** Default 50. */
  maxWriteSteps?: number;
  /** The frame key `define` compiles to; absent when the server takes no action proposals. */
  defineKey?: string;
}
export type CompileResult =
  | { plan: ActPlan }
  | { refusal: ActRefusal }
  | { help: ActHelp | ActHelp[] };

const DEFAULT_MAX_WRITE_STEPS = 50;
/** Each help step can answer the whole schema overview, so a reply's size is bounded by this. */
const MAX_HELP_STEPS = 10;
const FIND_LIMIT = 1000;
const WORD_NAME = /^[a-z][A-Za-z0-9]{1,31}$/;
const RESERVED_WORDS = ['create', 'update', 'find', 'count', 'define'];
/** `$`, `$name`, `$?` or `$name?` in a `define` argument. */
const PLACEHOLDER = /^\$([A-Za-z_][A-Za-z0-9_]*)?(\?)?$/;
const BUILT_IN: Record<'create' | 'update', ActionSchema> = {
  create: toActionSchema({ kind: 'create' }),
  update: toActionSchema({ kind: 'update' })
};

interface Target {
  ns: string;
  name: string;
  qualified: string;
  type: TypeSchema;
}
type Draft = Omit<ActPlanStep, 'step'>;
type Resolved = { value: unknown } | { late: ActLate };
/** Rewrites the current sketch step with `choice` in place of the offending token. */
type Swap = (step: ActStep, choice: string) => ActStep;

/** Unwinds to `compileSketch` carrying a refusal. */
class Refused {
  constructor(readonly refusal: ActRefusal) {}
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur.push(Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, sub));
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** A refusal echoes a long token clipped, in `token` and in `problem`. */
function clipped(r: ActRefusal): ActRefusal {
  if (r.token.length <= TOKEN_ECHO) return r;
  const short = clipToken(r.token);
  return { ...r, token: short, problem: r.problem.replaceAll(r.token, short) };
}

const isValue = (v: unknown): boolean =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (Array.isArray(v) && v.every(isValue));

/** The JSON form arrives from a request body; check its shape before reading it. */
function isStep(s: unknown): boolean {
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return false;
  const { action, type, refs, args, as } = s as Record<string, unknown>;
  return (
    typeof action === 'string' &&
    (type === undefined || typeof type === 'string') &&
    (refs === undefined || (Array.isArray(refs) && refs.every((r) => typeof r === 'string'))) &&
    (args === undefined ||
      (typeof args === 'object' &&
        args !== null &&
        !Array.isArray(args) &&
        Object.values(args).every(isValue))) &&
    (as === undefined || typeof as === 'string')
  );
}

const asList = (v: ActValue): ActValue[] => (Array.isArray(v) ? v : [v]);
const idFields = (type: TypeSchema): Record<string, true> =>
  Object.hasOwn(type.fields, 'shortId') ? { id: true, shortId: true } : { id: true };
const swapValue =
  (arg: string): Swap =>
  (s, c) => ({ ...s, args: { ...s.args, [arg]: c } });
const swapElement =
  (arg: string, list: ActValue[], i: number): Swap =>
  (s, c) => ({ ...s, args: { ...s.args, [arg]: list.map((v, j) => (j === i ? c : v)) } });
const swapKey =
  (arg: string): Swap =>
  (s, c) => ({
    ...s,
    args: Object.fromEntries(Object.entries(s.args ?? {}).map(([k, v]) => [k === arg ? c : k, v]))
  });

/** `schema` with the word a `define` draft coins added to its type; copies, never mutates. */
function withWord(schema: Readonly<Record<string, Schema>>, define: Draft): Record<string, Schema> {
  const { namespace, type, name, decl } = define.params as {
    namespace: string;
    type: string;
    name: string;
    decl: ActionDecl;
  };
  const ns = schema[namespace] as Schema;
  const t = ns.types[type] as TypeSchema;
  const actions = { ...t.actions, [name]: toActionSchema(decl) };
  return { ...schema, [namespace]: { ...ns, types: { ...ns.types, [type]: { ...t, actions } } } };
}

class Compiler {
  /** The sketch step being compiled, 1-based. */
  #n = 0;
  readonly #bindings = new Set<string>();
  /** Write steps built so far; checked at each one so a large expansion stops at the cap. */
  #writes = 0;

  constructor(
    public schema: Readonly<Record<string, Schema>>,
    readonly options: CompileOptions,
    readonly steps: ActStep[]
  ) {}

  run(): CompileResult {
    const { steps } = this;
    if (steps.length === 0) this.#at(1).#refuse('', 'empty sketch');
    const bad = steps.findIndex((s) => !isStep(s));
    if (bad !== -1) this.#at(bad + 1).#refuse('', 'malformed step');

    const helpAt = steps.findIndex((s) => s.action === '?');
    if (helpAt !== -1) {
      if (steps.some((s) => s.action !== '?')) {
        this.#at(helpAt + 1).#refuse('?', 'help stands alone');
      }
      if (steps.length > MAX_HELP_STEPS) {
        this.#at(MAX_HELP_STEPS + 1).#refuse('?', `at most ${MAX_HELP_STEPS} help steps`);
      }
      const help = steps.map((step, i) => {
        this.#at(i + 1);
        if (step.type === undefined) return typesHelp(this.schema);
        const target = this.#resolveType(step.type);
        return typeHelp(target.qualified, target.type);
      });
      return { help: help.length === 1 ? (help[0] as ActHelp) : help };
    }

    const drafts: Draft[] = [];
    let from = 0;
    const defineAt = steps.findIndex((s) => s.action === 'define');
    if (defineAt !== -1) {
      this.#at(defineAt + 1);
      if (defineAt !== 0) this.#refuse('define', 'define comes first');
      const again = steps.findIndex((s, i) => i > 0 && s.action === 'define');
      if (again !== -1) this.#at(again + 1).#refuse('define', 'one define per sketch');
      if (this.options.defineKey === undefined) {
        this.#refuse('define', 'this server takes no action proposals');
      }
      const define = this.#define(this.options.defineKey);
      drafts.push(define);
      // The steps after it compile against the word it coins, as its proposer will see it.
      this.schema = withWord(this.schema, define);
      from = 1;
    }

    for (const [i, step] of steps.entries()) {
      if (i >= from) this.#at(i + 1).#compileStep(step, drafts);
    }
    return { plan: { steps: drafts.map((d, i) => ({ step: i + 1, ...d })) } };
  }

  #at(n: number): this {
    this.#n = n;
    return this;
  }

  get #step(): ActStep {
    return this.steps[this.#n - 1] as ActStep;
  }

  /**
   * Throws the refusal. `nearest` swaps in the choice closest to `token` under
   * `key`; a token too long to echo gets none, so its distance is never measured.
   */
  #refuse(
    token: string,
    problem: string,
    choices: string[] = [],
    swap?: Swap,
    key: (choice: string) => string = (c) => c
  ): never {
    const sorted = [...new Set(choices)].sort();
    let nearest: string | null = null;
    if (swap !== undefined && sorted.length > 0 && token.length <= TOKEN_ECHO) {
      let best = sorted[0] as string;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const c of sorted) {
        const d = levenshtein(token, key(c));
        if (d < bestDistance) [best, bestDistance] = [c, d];
      }
      const n = this.#n;
      nearest = formatSketch(this.steps.map((s, i) => (i === n - 1 ? swap(s, best) : s)));
    }
    throw new Refused({
      code: 'sketch_unresolved',
      step: this.#n,
      token,
      problem,
      choices: sorted,
      nearest
    });
  }

  #target(ns: string, name: string): Target | undefined {
    const schema = Object.hasOwn(this.schema, ns) ? this.schema[ns] : undefined;
    const type =
      schema !== undefined && Object.hasOwn(schema.types, name) ? schema.types[name] : undefined;
    return type === undefined ? undefined : { ns, name, qualified: `${ns}/${name}`, type };
  }

  /** `suffix` is kept on the type token when a refusal swaps in a choice (`define` writes `.name` there). */
  #resolveType(token: string, suffix = ''): Target {
    const swap: Swap = (s, c) => ({ ...s, type: c + suffix });
    const slash = token.indexOf('/');
    const all = (qualified: boolean) =>
      Object.entries(this.schema).flatMap(([ns, s]) =>
        Object.keys(s.types).map((name) => (qualified ? `${ns}/${name}` : name))
      );
    if (slash !== -1) {
      const target = this.#target(token.slice(0, slash), token.slice(slash + 1));
      return target ?? this.#refuse(token, `unknown type '${token}'`, all(true), swap);
    }
    const owners = Object.keys(this.schema)
      .filter((ns) => this.#target(ns, token) !== undefined)
      .sort();
    const fallback = this.options.defaultNamespace;
    const ns =
      owners.length === 1
        ? owners[0]
        : fallback !== undefined && owners.includes(fallback)
          ? fallback
          : undefined;
    if (ns !== undefined) return this.#target(ns, token) as Target;
    if (owners.length > 1) {
      // Every choice names the type as written, so they are compared by name and tie.
      const choices = owners.map((o) => `${o}/${token}`);
      this.#refuse(token, `ambiguous type '${token}'`, choices, swap, (c) =>
        c.slice(c.indexOf('/') + 1)
      );
    }
    return this.#refuse(token, `unknown type '${token}'`, all(false), swap);
  }

  #local(ns: string, token: string): void {
    if (!this.options.localNamespaces.has(ns)) {
      this.#refuse(token, `${ns} is bridged or virtual; act runs on local stores only`);
    }
  }

  /** The one plan step that proposes a coined word: `define <Type>.<name> [past] field=<literal>|$|$name|$?|$name?|now`. */
  #define(key: string): Draft {
    const step = this.#step;
    const token = step.type ?? '';
    const dot = token.lastIndexOf('.');
    if (dot === -1) this.#refuse(token, 'define needs <Type>.<name>');
    const name = token.slice(dot + 1);
    const target = this.#resolveType(token.slice(0, dot), token.slice(dot));
    this.#local(target.ns, token);
    if (RESERVED_WORDS.includes(name)) this.#refuse(name, `'${name}' is a built-in action`);
    const badName = (n: string) =>
      this.#refuse(n, `name must match ${WORD_NAME.source} (two or more characters)`);
    if (!WORD_NAME.test(name)) badName(name);
    const [past, extra] = step.refs ?? [];
    if (extra !== undefined) this.#refuse(extra, 'define takes at most one past word');
    if (step.as !== undefined) this.#refuse(`$${step.as}`, 'define takes no binding');
    if (past !== undefined && !WORD_NAME.test(past)) badName(past);
    const args = step.args ?? {};
    if (Object.keys(args).length === 0) this.#refuse('define', 'define sets nothing');

    const fields = target.type.fields;
    const params: Record<string, ActionParamDecl> = {};
    const set: Record<string, ActionSetValue> = {};
    for (const [arg, raw] of Object.entries(args)) {
      const def = Object.hasOwn(fields, arg) ? fields[arg] : undefined;
      if (def === undefined) {
        const writable = Object.entries(fields)
          .filter(([, d]) => !(d.kind === 'scalar' && (d.readonly === true || d.serverSet)))
          .map(([f]) => f);
        this.#refuse(arg, `unknown field '${arg}' on ${target.qualified}`, writable, swapKey(arg));
      }
      if (def.kind === 'scalar' && (def.readonly === true || def.serverSet !== undefined)) {
        this.#refuse(arg, `${arg} is server-set`);
      }
      if (raw === 'now') {
        if (def.kind !== 'scalar' || def.type !== 'date') {
          this.#refuse(arg, `${arg}: now fits a date field only`);
        }
        set[arg] = { now: true };
        continue;
      }
      const ph = typeof raw === 'string' ? PLACEHOLDER.exec(raw) : null;
      if (ph === null) {
        const value = this.#coerce(def, raw, arg, swapValue(arg));
        if (typeof value === 'object' && value !== null) {
          this.#refuse(String(raw), `${arg}: define sets a single value`);
        }
        set[arg] = value as ActionSetValue;
        continue;
      }
      const param = ph[1] ?? arg;
      // A param's type is the field's, minus what only the server may set.
      let type: FieldDef = def;
      if (def.kind === 'scalar') {
        const { readonly: _r, serverSet: _s, ...rest } = def;
        type = rest;
      }
      const prior = Object.hasOwn(params, param) ? params[param] : undefined;
      if (
        prior !== undefined &&
        JSON.stringify((prior as { type: FieldDef }).type) !== JSON.stringify(type)
      ) {
        this.#refuse(String(raw), `param '${param}' is used for two field types`);
      }
      const optional = ph[2] !== undefined && (prior === undefined || prior.optional === true);
      params[param] = { type, ...(optional ? { optional: true } : {}) };
      set[arg] = { param };
    }

    const decl: ActionDecl = {
      kind: 'update',
      ...(past !== undefined ? { past } : {}),
      params,
      set
    };
    const shown = Object.entries(args).map(
      ([k, v]) => `${k}=${typeof v === 'string' && PLACEHOLDER.test(v) ? v : formatValue(v)}`
    );
    const sketch = [
      formatStep({
        action: 'define',
        type: `${target.qualified}.${name}`,
        ...(past !== undefined ? { refs: [past] } : {})
      }),
      ...shown
    ].join(' ');
    return {
      source: this.#n,
      action: 'define',
      type: target.qualified,
      key,
      operation: 'mutate',
      params: { namespace: target.ns, type: target.name, name, decl, sketch },
      fields: { id: true },
      past: 'defined'
    };
  }

  #compileStep(step: ActStep, out: Draft[]): void {
    if (step.type === undefined) this.#refuse(step.action, 'missing type');
    const target = this.#resolveType(step.type);
    this.#local(target.ns, step.type);
    const refs = step.refs ?? [];
    const args = step.args ?? {};

    if (step.action === 'find' || step.action === 'count') {
      if (step.as !== undefined) this.#refuse(`$${step.as}`, 'as needs a single record');
      out.push(this.#readStep(step.action, target, refs, args));
      return;
    }

    const declared = target.type.actions ?? {};
    const action = Object.hasOwn(declared, step.action)
      ? (declared[step.action] as ActionSchema)
      : step.action === 'create' || step.action === 'update'
        ? BUILT_IN[step.action]
        : this.#refuse(
            step.action,
            `unknown action '${step.action}' on ${target.qualified}`,
            [...Object.keys(declared), ...BUILT_IN_ACTIONS],
            (s, c) => ({ ...s, action: c })
          );
    if (action.kind === 'update' && refs.length === 0) {
      this.#refuse(step.action, `${step.action} needs a reference`);
    }
    if (action.kind === 'create' && refs.length > 0) {
      this.#refuse(refs[0] as string, `${step.action} takes no reference`);
    }
    if (step.as !== undefined && refs.length > 1) {
      this.#refuse(`$${step.as}`, 'as needs a single record');
    }
    this.#expand(
      target,
      step.action,
      action,
      action.kind === 'create' ? [undefined] : refs,
      args,
      out,
      step.as
    );
    if (step.as !== undefined) this.#bindings.add(step.as);
  }

  /**
   * One step per ref (`undefined` for a create), each followed by its `then`
   * entries, once per element of their `each` list, expanded recursively.
   */
  #expand(
    target: Target,
    name: string,
    action: ActionSchema,
    refs: readonly (ActValue | undefined)[],
    args: Record<string, ActValue>,
    out: Draft[],
    bind?: string
  ): void {
    const mutation = `${action.kind}${target.name}`;
    if (!Object.hasOwn((this.schema[target.ns] as Schema).mutations, mutation)) {
      this.#refuse(this.#step.action, `${target.qualified} has no ${mutation} mutation`);
    }
    const built = this.#buildParams(target, name, action, args);
    const thens = action.then.flatMap((t) => {
      const elements = built.lists.get(t.each.param) ?? [];
      return elements.length > 0 ? [{ ...this.#thenTarget(t), elements }] : [];
    });
    for (const ref of refs) {
      const params: Record<string, unknown> = {};
      const late: Record<string, ActLate> = {};
      if (ref !== undefined) {
        const r = this.#resolveRef(ref);
        if ('late' in r) late.id = r.late;
        else params.id = r.value;
      }
      Object.assign(params, built.params);
      Object.assign(late, built.late);
      const max = this.options.maxWriteSteps ?? DEFAULT_MAX_WRITE_STEPS;
      if (++this.#writes > max) {
        this.#refuse('', `${this.#writes} write steps exceed the cap of ${max}`);
      }
      out.push({
        source: this.#n,
        action: name,
        type: target.qualified,
        key: `${target.ns}/${mutation}`,
        operation: 'mutate',
        params,
        ...(Object.keys(late).length > 0 ? { late } : {}),
        fields: idFields(target.type),
        ...(action.past !== undefined ? { past: action.past } : {}),
        ...(bind !== undefined ? { bind } : {})
      });
      for (const t of thens) {
        for (const el of t.elements) this.#expand(t.target, t.name, t.action, [el], {}, out);
      }
    }
  }

  #thenTarget(then: ActionThenDecl): { target: Target; name: string; action: ActionSchema } {
    const dot = then.action.lastIndexOf('.');
    const qualified = then.action.slice(0, dot);
    const name = then.action.slice(dot + 1);
    const slash = qualified.indexOf('/');
    const target = this.#target(qualified.slice(0, slash), qualified.slice(slash + 1));
    const actions = target?.type.actions ?? {};
    if (target === undefined || dot === -1 || !Object.hasOwn(actions, name)) {
      return this.#refuse(this.#step.action, `then target ${then.action} does not exist`);
    }
    const action = actions[name] as ActionSchema;
    if (action.kind === 'create') {
      this.#refuse(this.#step.action, `then target ${then.action} is a create action`);
    }
    this.#local(target.ns, this.#step.action);
    return { target, name, action };
  }

  #resolveRef(ref: ActValue): Resolved {
    if (typeof ref !== 'string') return this.#refuse(String(ref), 'not a reference');
    const body = /^[#$]/.test(ref) ? ref.slice(1) : ref;
    if (body === '') return this.#refuse(ref, 'empty reference');
    if (!REF.test(ref)) return this.#refuse(ref, 'not a reference');
    if (!ref.startsWith('$')) return { value: body };
    if (!this.#bindings.has(body)) return this.#refuse(ref, `unknown binding '${ref}'`);
    return { late: { bind: body } };
  }

  /** `raw` as `def` expects it, or a refusal offering the enum's values. */
  #coerce(def: FieldDef, raw: ActValue, name: string, swap?: Swap): unknown {
    const r = coerceValue(def, raw);
    if (r.ok) return r.value;
    const choices = def.kind === 'scalar' && def.enum !== undefined ? [...def.enum] : [];
    return this.#refuse(String(raw), `${name}: ${r.problem}`, choices, swap);
  }

  /**
   * A write value. A crossRef may name a binding or a shortId, both resolved at
   * execution; a shortId is looked up on its target, which must be local.
   */
  #writeValue(def: FieldDef, raw: ActValue, name: string, swap?: Swap): Resolved {
    if (def.kind === 'crossRef' && typeof raw === 'string') {
      if (raw.startsWith('$')) return this.#resolveRef(raw);
      const shortId = /^#\d+$/.test(raw) ? Number(raw.slice(1)) : undefined;
      if (shortId !== undefined && Number.isSafeInteger(shortId)) {
        this.#local(def.ns, raw);
        return { late: { ref: { type: `${def.ns}/${def.type}`, shortId } } };
      }
    }
    if (def.kind === 'list' && def.of.kind === 'crossRef') {
      for (const el of asList(raw)) {
        if (typeof el === 'string' && /^[#$]/.test(el))
          this.#refuse(el, `${name} takes full ids only`);
      }
    }
    return { value: this.#coerce(def, raw, name, swap) };
  }

  /** Params and late values after `id`: the action's `set` in order, then extra fields in sketch order. */
  #buildParams(target: Target, name: string, action: ActionSchema, args: Record<string, ActValue>) {
    const fields = target.type.fields;
    const serverOwned = (def: FieldDef) =>
      def.kind === 'scalar' &&
      (def.readonly === true || def.serverSet === 'both' || def.serverSet === action.kind);
    const given = new Map<string, Resolved>();
    const lists = new Map<string, ActValue[]>();
    const extras: Array<[string, Resolved]> = [];

    for (const [arg, raw] of Object.entries(args)) {
      if (arg === 'id') this.#refuse(arg, 'id comes from the reference');
      const param = Object.hasOwn(action.params, arg) ? action.params[arg] : undefined;
      if (param !== undefined) {
        if ('list' in param) lists.set(arg, asList(raw));
        else given.set(arg, this.#writeValue(param.type, raw, arg, swapValue(arg)));
        continue;
      }
      if (action.fixed.includes(arg)) this.#refuse(arg, `${arg} is fixed by ${name}`);
      const def = Object.hasOwn(fields, arg) ? fields[arg] : undefined;
      if (def === undefined) {
        const writable = Object.entries(fields)
          .filter(([f, d]) => !action.fixed.includes(f) && !serverOwned(d))
          .map(([f]) => f);
        this.#refuse(
          arg,
          `unknown field '${arg}' on ${target.qualified}`,
          [...Object.keys(action.params), ...writable],
          swapKey(arg)
        );
      }
      if (serverOwned(def)) this.#refuse(arg, `${arg} is server-set`);
      extras.push([arg, this.#writeValue(def, raw, arg, swapValue(arg))]);
    }

    for (const [p, decl] of Object.entries(action.params)) {
      const required = decl.optional !== true && !('default' in decl && decl.default !== undefined);
      if (required && !given.has(p) && !lists.has(p)) {
        this.#refuse(this.#step.action, `missing param '${p}'`, [p]);
      }
    }

    const params: Record<string, unknown> = {};
    const late: Record<string, ActLate> = {};
    const put = (field: string, r: Resolved) => {
      if ('late' in r) late[field] = r.late;
      else params[field] = r.value;
    };
    for (const [field, value] of Object.entries(action.set)) {
      if (value === null || typeof value !== 'object') params[field] = value;
      else if ('now' in value) late[field] = { now: true };
      else {
        const r = given.get(value.param) ?? this.#paramDefault(action, value.param, lists);
        if (r !== undefined) put(field, r);
      }
    }
    for (const [field, r] of extras) put(field, r);
    return { params, late, lists };
  }

  /** An absent param's value: its default, or undefined when it is optional. */
  #paramDefault(
    action: ActionSchema,
    name: string,
    lists: Map<string, ActValue[]>
  ): Resolved | undefined {
    const decl = Object.hasOwn(action.params, name) ? action.params[name] : undefined;
    if (decl === undefined) return undefined;
    if ('list' in decl) return lists.has(name) ? { value: lists.get(name) } : undefined;
    return decl.default === undefined ? undefined : this.#writeValue(decl.type, decl.default, name);
  }

  /** References filter on `shortId` (`#N`) or `id`; each `field=value` adds an `eq` or `in`. */
  #readStep(
    action: 'find' | 'count',
    target: Target,
    refs: readonly string[],
    args: Record<string, ActValue>
  ): Draft {
    const fields = target.type.fields;
    const names = Object.keys(fields);
    const unknown = (token: string, swap: Swap) =>
      this.#refuse(token, `unknown field '${token}' on ${target.qualified}`, names, swap);
    const where: Record<string, unknown> = {};
    if (refs.length > 0) {
      const short = (refs[0] as string).startsWith('#');
      const values = refs.map((ref) => {
        const r = this.#resolveRef(ref);
        if ('late' in r) return this.#refuse(ref, `${action} takes no binding`);
        if (ref.startsWith('#') !== short) {
          this.#refuse(ref, `${action} takes shortIds or ids, not both`);
        }
        return short ? Number(r.value) : r.value;
      });
      if (short && !Object.hasOwn(fields, 'shortId')) {
        this.#refuse(refs[0] as string, `${target.qualified} has no shortId`);
      }
      const key = short ? 'shortId' : 'id';
      if (Object.hasOwn(args, key)) this.#refuse(refs[0] as string, `${key} is given twice`);
      where[key] = values.length === 1 ? { eq: values[0] } : { in: values };
    }
    const select = idFields(target.type);
    for (const [arg, raw] of Object.entries(args)) {
      if (action === 'find' && arg === 'fields') {
        const list = asList(raw);
        for (const [i, f] of list.entries()) {
          if (typeof f !== 'string' || !Object.hasOwn(fields, f))
            unknown(String(f), swapElement(arg, list, i));
          select[f as string] = true;
        }
        continue;
      }
      const def = Object.hasOwn(fields, arg) ? fields[arg] : undefined;
      if (def === undefined) return unknown(arg, swapKey(arg));
      const operand = (v: ActValue, swap: Swap) => {
        if (def.kind === 'crossRef' && typeof v === 'string' && v.startsWith('#')) {
          this.#refuse(v, `${v} cannot filter ${arg}; use the record's id`);
        }
        return this.#coerce(def, v, arg, swap);
      };
      where[arg] = Array.isArray(raw)
        ? { in: raw.map((el, i) => operand(el, swapElement(arg, raw, i))) }
        : { eq: operand(raw, swapValue(arg)) };
    }
    return {
      source: this.#n,
      action,
      type: target.qualified,
      key: target.qualified,
      operation: 'query',
      params: action === 'find' ? { where, limit: FIND_LIMIT } : { where, count: true },
      fields: action === 'find' ? select : { id: true }
    };
  }
}

export function compileSketch(
  sketch: string | ActStep[],
  schema: Readonly<Record<string, Schema>>,
  options: CompileOptions
): CompileResult {
  let steps: ActStep[];
  if (typeof sketch === 'string') {
    const parsed = parseSketch(sketch);
    if ('refusal' in parsed) return { refusal: clipped(parsed.refusal) };
    steps = parsed.steps;
  } else steps = sketch;
  try {
    return new Compiler(schema, options, steps).run();
  } catch (e) {
    if (e instanceof Refused) return { refusal: clipped(e.refusal) };
    throw e;
  }
}
