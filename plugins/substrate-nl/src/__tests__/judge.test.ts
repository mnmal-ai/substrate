import { describe, expect, it } from 'vitest';
import {
  buildJudgePrompt,
  checkChoice,
  type Judge,
  type JudgePrompt,
  parseWithJudge
} from '../judge/judge.js';
import { parseQuestion } from '../parse/parse.js';
import { ctx, pack } from './_fixture.js';

/** A judge that replays scripted replies and records what it was offered. */
function scripted(...replies: unknown[]): Judge & { prompts: JudgePrompt[] } {
  const prompts: JudgePrompt[] = [];
  return {
    prompts,
    async decide(prompt) {
      prompts.push(prompt);
      return replies.shift();
    }
  };
}

const where = (r: Awaited<ReturnType<typeof parseWithJudge>>) =>
  r.status === 'resolved' ? Object.values(r.candidate.frame)[0]?.params.where : undefined;

describe('the options offered', () => {
  it('offers only what this parse can use', () => {
    const r = parseQuestion('what about zebras', pack, ctx);
    expect(r.status).toBe('unparsed');
    const p = buildJudgePrompt('what about zebras', r, pack);
    type Branch = { properties: Record<string, { const?: string; enum?: unknown[] }> };
    const branches = p.schema.anyOf as Branch[];
    const of = (a: string) => branches.find((b) => b.properties.action?.const === a);
    expect(of('pick')).toBeUndefined();
    expect(of('bind')?.properties.word?.enum).toEqual(['zebras']);
    expect(of('type')?.properties.type?.enum).toContain('Todo');
  });

  it('rejects a reply outside the options', () => {
    const r = parseQuestion('what about zebras', pack, ctx);
    const p = buildJudgePrompt('what about zebras', r, pack);
    expect(checkChoice({ action: 'type', type: 'Zebra' }, p)).toMatch(/needs an offered type/);
    expect(checkChoice({ action: 'pick', candidate: 0 }, p)).toMatch(/not offered/);
    expect(checkChoice({ action: 'bind', word: 'zebras', field: 'Todo.title' }, p)).toMatch(/op/);
  });
});

describe('applying a choice', () => {
  it('never calls the model for a resolved parse', async () => {
    const judge = scripted();
    const r = await parseWithJudge('open todos', pack, ctx, judge);
    expect(r.status).toBe('resolved');
    expect(judge.prompts).toHaveLength(0);
  });

  it('a type choice re-parses as that type; leftovers go back to the judge', async () => {
    const r = await parseWithJudge(
      'what happened yesterday',
      pack,
      ctx,
      scripted({ action: 'type', type: 'SessionLog' }, { action: 'pick', candidate: 0 })
    );
    expect(r.status).toBe('resolved');
    expect(r.status === 'resolved' && r.candidate.type).toBe('SessionLog');
    expect(JSON.stringify(where(r))).toContain('createdAt');
  });

  it('a binding becomes a predicate on the bound word, verbatim', async () => {
    const r = await parseWithJudge(
      'agents for zebra',
      pack,
      ctx,
      scripted({ action: 'bind', word: 'zebra', field: 'AgentIdentity.kid', op: 'startsWith' })
    );
    expect(r.status).toBe('resolved');
    expect(JSON.stringify(where(r))).toContain('{"kid":{"startsWith":"zebra"}}');
  });

  it('recall, clarify and refuse end the round without a frame', async () => {
    for (const action of ['recall', 'clarify', 'refuse'] as const) {
      const r = await parseWithJudge('what about zebras', pack, ctx, scripted({ action }));
      expect(r.status).toBe(action);
    }
  });

  it('an invalid reply leaves the question escalated, with the reason', async () => {
    const r = await parseWithJudge('what about zebras', pack, ctx, scripted({ action: 'dance' }));
    expect(r.status).toBe('escalated');
    expect(r.trail[0]?.rejected).toMatch(/not offered/);
  });

  it('escalate hands the question on unchanged', async () => {
    const r = await parseWithJudge(
      'what about zebras',
      pack,
      ctx,
      scripted({ action: 'escalate' })
    );
    expect(r.status).toBe('escalated');
  });
});

describe('verifying a binding', () => {
  const bind = (word: string, field: string, op = 'eq') =>
    scripted({ action: 'bind', word, field, op });

  it('refuses an eq binding outside an enum, without asking the data', async () => {
    let asked = false;
    const r = await parseWithJudge('todos for zebra', pack, ctx, bind('zebra', 'Todo.status'), {
      exists: async () => {
        asked = true;
        return true;
      }
    });
    expect(r.status).toBe('escalated');
    expect(r.trail[0]?.rejected).toMatch(/not a Todo.status value/);
    expect(asked).toBe(false);
  });

  it('refuses a binding whose value occurs in no row', async () => {
    const seen: unknown[] = [];
    const r = await parseWithJudge(
      'agents for zebra',
      pack,
      ctx,
      bind('zebra', 'AgentIdentity.kid', 'startsWith'),
      {
        exists: async (type, where) => {
          seen.push([type, where]);
          return false;
        }
      }
    );
    expect(r.status).toBe('escalated');
    expect(seen).toEqual([['AgentIdentity', { kid: { startsWith: 'zebra' } }]]);
  });

  it('applies a binding that grounds, including contains', async () => {
    const r = await parseWithJudge(
      'todos about zebra',
      pack,
      ctx,
      bind('zebra', 'Todo.title', 'contains'),
      {
        exists: async () => true
      }
    );
    expect(r.status).toBe('resolved');
    expect(JSON.stringify(where(r))).toContain('{"title":{"contains":"zebra"}}');
  });

  it('checks bindings jointly, not one at a time', async () => {
    const seen: unknown[] = [];
    const judge = scripted(
      { action: 'bind', word: 'zebra', field: 'Todo.title', op: 'contains' },
      { action: 'bind', word: 'quagga', field: 'Todo.title', op: 'contains' }
    );
    const r = await parseWithJudge('todos about zebra quagga', pack, ctx, judge, {
      exists: async (_type, where) => {
        seen.push(where);
        return !('AND' in where);
      }
    });
    expect(seen[1]).toEqual({
      AND: [{ title: { contains: 'zebra' } }, { title: { contains: 'quagga' } }]
    });
    expect(r.trail[1]?.rejected).toMatch(/together with "zebra"/);
  });
});
