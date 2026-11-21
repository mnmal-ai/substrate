import { createClientFromEnv, type SubstrateClient } from '@mnmal-ai/substrate-client';
import { type ActRequest, stringifyJson } from '@mnmal-ai/substrate-types';
import { sanitise } from '@mnmal-ai/surface-core/pure';

export interface ActCliOptions {
  write?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const USAGE =
  'usage: substrate act [--dry-run] [--ns <namespace>] [--key <idempotencyKey>] [--json] <sketch…> | --result <id> [--json]\n';

export async function runAct(argv: string[], options: ActCliOptions = {}): Promise<number> {
  const write = options.write ?? ((s: string) => process.stdout.write(s));
  const env = options.env ?? process.env;
  let ns =
    env.SUBSTRATE_NAMESPACE !== undefined && env.SUBSTRATE_NAMESPACE !== ''
      ? env.SUBSTRATE_NAMESPACE
      : undefined;
  let key: string | undefined;
  let resultId: string | undefined;
  let dryRun = false;
  let json = false;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--json') json = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--ns' || a === '--key' || a === '--result') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        write(USAGE);
        return 2;
      }
      if (a === '--ns') ns = v;
      else if (a === '--key') key = v;
      else resultId = v;
    } else words.push(a);
  }
  const sketch = words.join(' ');
  if ((resultId === undefined) === (sketch === '')) {
    write(USAGE);
    return 2;
  }
  if ((env.SUBSTRATE_URL ?? '') === '') {
    write('SUBSTRATE_URL is required (e.g. https://substrate.example.com:3100)\n');
    return 2;
  }

  // A missing or broken key is a config error, not a stack trace.
  let client: SubstrateClient;
  try {
    ({ client } = createClientFromEnv({
      env,
      allowAnonymous: false,
      ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {})
    }));
  } catch (err) {
    write(`substrate act: agent identity: ${sanitise(messageOf(err))}\n`);
    return 2;
  }

  // JSON.stringify escapes C0 but not C1 controls (U+009B is a CSI to some terminals).
  const asJson = (v: unknown): string =>
    `${stringifyJson(v, 2).replace(/[\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
  const line = (s: unknown): string => sanitise(String(s));

  try {
    if (resultId !== undefined) {
      write(asJson(await client.actResult(resultId)));
      return 0;
    }
    const req: ActRequest = {
      sketch,
      ...(dryRun ? { mode: 'dry-run' as const } : {}),
      ...(ns !== undefined ? { namespace: ns } : {}),
      ...(key !== undefined ? { idempotencyKey: key } : {})
    };
    const reply = await client.act(req);
    if (json) write(asJson(reply));
    if ('refusal' in reply) {
      const r = reply.refusal;
      if (!json) {
        write(`refused at step ${stepOf(r.step)}: ${line(r.problem)}\n`);
        if (r.choices.length > 0) write(`  choices: ${r.choices.map(line).join(', ')}\n`);
        if (r.nearest !== null) write(`  nearest: ${line(r.nearest)}\n`);
      }
      return 1;
    }
    if ('error' in reply) {
      if (!json) {
        const e = reply.error;
        write(`failed at step ${stepOf(e.step)}: ${line(e.code)}: ${line(e.message)}\n`);
        if (reply.result !== null) write(`result ${line(reply.result)}\n`);
      }
      return 1;
    }
    if (!json) {
      if ('help' in reply) write(asJson(reply.help));
      else
        write(
          `${line(reply.ack)}\n${reply.result !== null ? `result ${line(reply.result)}\n` : ''}`
        );
    }
    return 0;
  } catch (err) {
    // Only the message: never the cause chain, which can carry request detail.
    write(`substrate act: ${line(messageOf(err))}\n`);
    return 1;
  }
}

// A step is a number; anything else the server sent prints as `?`, never raw.
function stepOf(step: unknown): string {
  return Number.isInteger(step) ? String(step) : '?';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
