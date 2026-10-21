/** Surgery command arguments and the target the tier-2 gesture asks to be typed. */

export interface TypeRef {
  readonly namespace: string;
  readonly type: string;
}

export type SurgeryOp =
  | { readonly kind: 'drop-namespace'; readonly namespace: string; readonly cascade: boolean }
  | {
      readonly kind: 'drop-type';
      readonly namespace: string;
      readonly type: string;
      readonly cascade: boolean;
    }
  | {
      readonly kind: 'backfill';
      readonly namespace: string;
      readonly type: string;
      readonly field: string;
      readonly valuesPath: string;
      readonly overwrite: boolean;
    }
  | {
      readonly kind: 'normalise';
      readonly namespace: string;
      readonly type: string;
      readonly field: string;
      readonly reject: readonly string[];
    }
  /** `targets` empty: every embedded type. */
  | { readonly kind: 'reindex'; readonly targets: readonly TypeRef[] };

export type SurgeryCommand = SurgeryOp['kind'];

const NS = /^[A-Za-z_][\w-]*$/;
const TYPE = /^([A-Za-z_][\w-]*)\/([A-Za-z_]\w*)$/;
const FIELD = /^([A-Za-z_][\w-]*)\/([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;

const USAGE: Record<SurgeryCommand, string> = {
  'drop-namespace': 'usage: /drop-namespace <ns> [--cascade]',
  'drop-type': 'usage: /drop-type <ns>/<Type> [--cascade]',
  backfill: 'usage: /backfill <ns>/<Type>.<field> --values <file.json> [--overwrite]',
  normalise: 'usage: /normalise <ns>/<Type>.<field> [--reject a,b]',
  reindex: 'usage: /reindex [<ns>/<Type> …]'
};

/** The deployment's own namespace. The server refuses to drop it too; this fails earlier and says why. */
const SUBSTRATE = '_system';
const OWN = "_system is the deployment's own namespace and cannot be dropped";

/** Flags each command takes; `true` means the flag carries a value. */
const FLAGS: Record<SurgeryCommand, Record<string, boolean>> = {
  'drop-namespace': { '--cascade': false },
  'drop-type': { '--cascade': false },
  backfill: { '--values': true, '--overwrite': false },
  normalise: { '--reject': true },
  reindex: {}
};

export function parseOp(
  command: SurgeryCommand,
  args: readonly string[]
): SurgeryOp | { readonly error: string } {
  const usage = { error: USAGE[command] };
  const allowed = FLAGS[command];
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    if (!(a in allowed)) return { error: `unknown flag '${a}' for /${command}` };
    // A repeat is ambiguous (which --values?), so it is refused rather than last-one-wins.
    if (flags.has(a)) return { error: `flag '${a}' given twice for /${command}` };
    if (allowed[a]) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return usage;
      flags.set(a, v);
      i++;
    } else {
      flags.set(a, true);
    }
  }

  switch (command) {
    case 'drop-namespace': {
      const [ns, ...rest] = positional;
      if (ns === undefined || rest.length > 0 || !NS.test(ns)) return usage;
      if (ns === SUBSTRATE) return { error: OWN };
      return { kind: 'drop-namespace', namespace: ns, cascade: flags.has('--cascade') };
    }
    case 'drop-type': {
      const m = positional.length === 1 ? TYPE.exec(positional[0] as string) : null;
      if (m === null) return usage;
      if (m[1] === SUBSTRATE) return { error: OWN };
      return {
        kind: 'drop-type',
        namespace: m[1] as string,
        type: m[2] as string,
        cascade: flags.has('--cascade')
      };
    }
    case 'backfill': {
      const m = positional.length === 1 ? FIELD.exec(positional[0] as string) : null;
      const values = flags.get('--values');
      if (m === null || typeof values !== 'string') return usage;
      return {
        kind: 'backfill',
        namespace: m[1] as string,
        type: m[2] as string,
        field: m[3] as string,
        valuesPath: values,
        overwrite: flags.has('--overwrite')
      };
    }
    case 'normalise': {
      const m = positional.length === 1 ? FIELD.exec(positional[0] as string) : null;
      if (m === null) return usage;
      const csv = flags.get('--reject');
      return {
        kind: 'normalise',
        namespace: m[1] as string,
        type: m[2] as string,
        field: m[3] as string,
        reject:
          typeof csv === 'string'
            ? csv
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s !== '')
            : []
      };
    }
    case 'reindex': {
      const targets: TypeRef[] = [];
      for (const p of positional) {
        const m = TYPE.exec(p);
        if (m === null) return usage;
        if (targets.some((t) => t.namespace === m[1] && t.type === m[2])) {
          return { error: `${p} named twice` };
        }
        targets.push({ namespace: m[1] as string, type: m[2] as string });
      }
      return { kind: 'reindex', targets };
    }
  }
}

/** What the tier-2 gesture asks to be typed. Never pre-filled. */
export function targetOf(op: SurgeryOp): string {
  switch (op.kind) {
    case 'drop-namespace':
      return op.namespace;
    case 'drop-type':
      return `${op.namespace}/${op.type}`;
    case 'backfill':
    case 'normalise':
      return `${op.namespace}/${op.type}.${op.field}`;
    case 'reindex':
      return 'reindex';
  }
}
