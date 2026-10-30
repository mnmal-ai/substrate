import { describe, expect, it } from 'vitest';
import { buildNamespacePack } from '../pack/build.js';
import type { NamespaceRulings } from '../pack/rulings.js';
import { parseQuestion } from '../parse/parse.js';
import { rangeFor } from '../parse/time.js';
import { ctx, OPERATORS, pack, SCOPE, s } from './_fixture.js';

const parse = (q: string) => parseQuestion(q, pack, ctx);
const params = (q: string) => Object.values(parse(q).candidates[0]?.frame ?? {})[0]?.params;

describe('refusal and clarification', () => {
  it('refuses an imperative edit', () => {
    expect(parse('Please close #227, #629')).toMatchObject({
      status: 'refuse',
      reason: '"close" is an edit; substrate-nl answers questions and does not change data'
    });
    expect(parse('Approved on #912 - merge whenever CI is green').status).toBe('refuse');
  });

  it('has no built-in opinion about pull requests', () => {
    expect(parse("What's in PR #1007?").status).not.toBe('refuse');
    expect(parse('latest pull request').status).not.toBe('refuse');
  });

  it('does not mistake a past-tense question for an edit', () => {
    expect(parse('What did we close today?').status).not.toBe('refuse');
  });

  it('asks about a bare #N, and about a bare number', () => {
    expect(parse('#942 please').status).toBe('clarify');
    expect(parse('show me 1193').status).toBe('clarify');
  });
});

describe('ids', () => {
  it('reads a state question about #N as the default id type, commentary and all', () => {
    const r = parse("What's #760? I thought we'd handled that?");
    expect(r.status).toBe('resolved');
    expect(r.candidates[0]?.frame).toEqual({
      'ns/Todo': { params: { where: { shortId: { eq: 760 } } } }
    });
    expect(r.candidates[0]?.answer).toBe('single');
  });

  it('honours an explicit type word, with or without #', () => {
    expect(Object.keys(parse('Show me Decision #473').candidates[0]?.frame ?? {})).toEqual([
      'ns/Decision'
    ]);
    expect(params('show me todo 1171')).toEqual({ where: { shortId: { eq: 1171 } } });
  });

  it('collects several ids into one in', () => {
    expect(params('Show me #1171 and #1193')).toEqual({ where: { shortId: { in: [1171, 1193] } } });
  });

  it('answers a field ask', () => {
    expect(parse('Which repo needs #1309?').candidates[0]?.answer).toBe('field:project');
  });
});

describe('lists and defaults', () => {
  it('applies open, unarchived and the asking project to "the todos"', () => {
    const r = parse('what is in our todos?');
    expect(r.status).toBe('resolved');
    expect(r.candidates[0]?.evidence.some((e) => e.role === 'scope')).toBe(true);
    expect(params('what is in our todos?')).toEqual({
      where: {
        AND: [{ status: { eq: 'open' } }, { archived: { eq: false } }, SCOPE]
      }
    });
  });

  it('reads a value as the most categorical field that holds it', () => {
    // 'substrate' is both a Todo project (2 values) and area (4 values).
    expect(params("what's open in substrate")).toEqual({
      where: {
        AND: [
          { project: { eq: 'substrate' } },
          { status: { eq: 'open' } },
          { archived: { eq: false } }
        ]
      }
    });
  });

  it('drops the default scope for "every project"', () => {
    const w = JSON.stringify(params("what's open across every project"));
    expect(w).not.toContain('"project"');
  });

  it('turns an enum value into its field and infers the type from it', () => {
    const r = parse('what are the must rules?');
    expect(Object.keys(r.candidates[0]?.frame ?? {})).toEqual(['ns/AgentRule']);
    expect(params('what are the must rules?')).toEqual({
      where: { AND: [{ severity: { eq: 'must' } }, { active: { eq: true } }, SCOPE] }
    });
  });

  it('keeps a value the type cannot hold out of that reading', () => {
    // 'high' is Todo.priority and AgentRule.severity; "todos" pins Todo.
    expect(JSON.stringify(params('show me the high priority todos'))).toContain(
      '"priority":{"eq":"high"}'
    );
  });

  it('reads "closed today" as terminal statuses updated today', () => {
    expect(params('what did we close today?')).toEqual({
      where: {
        AND: [
          { updatedAt: { gte: '2026-10-02T00:00:00-05:00', lt: '2026-10-03T00:00:00-05:00' } },
          { status: { in: ['done', 'closed'] } },
          SCOPE
        ]
      }
    });
  });
});

describe('ordering, counting, authors', () => {
  it('matches a plural word to its singular stored value', () => {
    const r = parseQuestion('todos tagged releases', pack, ctx);
    expect(r.status).toBe('resolved');
    expect(JSON.stringify(Object.values(r.candidates[0]?.frame ?? {})[0]?.params)).toContain(
      '{"tags":{"has":"release"}}'
    );
  });

  it('treats values beside an id as commentary ("#5, is that recall?")', () => {
    const r = parseQuestion('todo #5, is that recall or ops?', pack, ctx);
    expect(r.status).toBe('resolved');
    expect(Object.values(r.candidates[0]?.frame ?? {})[0]?.params).toEqual({
      where: { shortId: { eq: 5 } }
    });
  });

  it('reads "most recently" as latest', () => {
    const r = parseQuestion('which decision did we make most recently', pack, ctx);
    expect(r.status).toBe('resolved');
    expect(Object.values(r.candidates[0]?.frame ?? {})[0]?.params).toMatchObject({ limit: 1 });
  });

  it('reads latest as createdAt desc, limit 1, with no open default', () => {
    const r = parse('Can you show me the last AnchorIntent we wrote');
    expect(r.status).toBe('resolved');
    expect(params('Can you show me the last AnchorIntent we wrote')).toEqual({
      where: SCOPE,
      orderBy: [{ createdAt: 'desc' }],
      limit: 1
    });
  });

  it('counts', () => {
    expect(parse('how many open todos do we have?').candidates[0]?.answer).toBe('count');
  });

  it('a count with no walks keeps the paging frame, with no walk in its plan and nothing dropped', () => {
    const c = parse('how many open todos do we have?').candidates[0];
    expect(c?.frame['ns/Todo']?.params.count).toBeUndefined();
    expect(c?.plan).toEqual([]);
    expect(c?.dropped).toEqual([]);
  });

  it('keeps a percentage as one word, outside a namespace with fieldPhrases', () => {
    expect(parse('todos with 25% budget').residual).toContain('25%');
  });

  it('filters by author on createdById', () => {
    expect(JSON.stringify(params('show me todos raised by peer-agent@host'))).toContain(
      '{"createdById":{"startsWith":"peer-agent@host"}}'
    );
  });
});

describe('escalation', () => {
  it('reports two readings as ambiguous rather than picking one', () => {
    expect(parse('show me substrate').status).toBe('ambiguous');
  });

  it('reports unexplained content words as partial, naming them', () => {
    const r = parse('what do we know about stale todos?');
    expect(r.status).toBe('partial');
    expect(r.residual).toEqual(['know', 'stale']);
  });

  it('returns unparsed when nothing matches', () => {
    expect(parse("what's the weather in sweden?").status).toBe('unparsed');
  });

  it('is deterministic', () => {
    const q = "what's open in substrate this week";
    expect(JSON.stringify(parse(q))).toBe(JSON.stringify(parse(q)));
  });
});

describe('rangeFor', () => {
  const asOf = '2026-10-02T12:00:00-05:00'; // a Friday
  it('computes calendar ranges in the asking offset, weeks from Monday', () => {
    expect(rangeFor('this week', asOf)).toEqual({
      gte: '2026-09-28T00:00:00-05:00',
      lt: '2026-10-05T00:00:00-05:00'
    });
    expect(rangeFor('yesterday', asOf)).toEqual({
      gte: '2026-10-01T00:00:00-05:00',
      lt: '2026-10-02T00:00:00-05:00'
    });
    expect(rangeFor('last month', asOf)).toEqual({
      gte: '2026-09-01T00:00:00-05:00',
      lt: '2026-10-01T00:00:00-05:00'
    });
    expect(rangeFor('since monday', asOf)).toEqual({
      gte: '2026-09-28T00:00:00-05:00',
      lt: '2026-10-03T00:00:00-05:00'
    });
    expect(rangeFor('open', asOf)).toBeNull();
  });
});

describe('operator rulings', () => {
  it('scopes to the asking project or none, except for unscoped types', () => {
    expect(JSON.stringify(params('which agents are active?'))).not.toContain('project');
  });

  it('searches the whole record for a question about the past', () => {
    for (const q of [
      'show me the archived todos',
      'which todos did we finish last week',
      'show the superseded decisions'
    ]) {
      expect(JSON.stringify(params(q)), q).not.toContain('"archived":{"eq":false}');
    }
    expect(JSON.stringify(params('show me the todos'))).toContain('"archived":{"eq":false}');
  });

  it('applies value aliases from the rulings', () => {
    expect(JSON.stringify(params('show the accepted decisions'))).toContain(
      '{"status":{"in":["active","accepted"]}}'
    );
    expect(JSON.stringify(params('list the signal-gated todos'))).toContain(
      '{"title":{"startsWith":"[SG]"}}'
    );
  });

  it('lets a type alias settle a phrase two types share', () => {
    expect(Object.keys(parse('show me the sessions').candidates[0]?.frame ?? {})).toEqual([
      'ns/SessionLog'
    ]);
    const bare = parseQuestion('show me the sessions', pack, { ...ctx, rulings: {} });
    expect(bare.status).toBe('ambiguous');
  });
});

describe('field words', () => {
  it('credits a field word next to its value', () => {
    expect(parse('show me the high priority todos').status).toBe('resolved');
    expect(parse('which todos are tagged recall?').status).toBe('resolved');
  });

  it('puts a time range on a date field the question names', () => {
    expect(JSON.stringify(params('which todos have a target date this month?'))).toContain(
      '{"targetDate":{"gte":"2026-10-01T00:00:00-05:00","lt":"2026-11-01T00:00:00-05:00"}}'
    );
  });

  it('reads a yes/no field named on its own as true', () => {
    expect(JSON.stringify(params('which rules are pinned?'))).toContain('{"pinned":{"eq":true}}');
  });

  it('reads "which <plural field>" as a grouping, across every value of it', () => {
    expect(parse('which projects have open todos?').candidates[0]?.answer).toBe('group:project');
    expect(JSON.stringify(params('which projects have open todos?'))).not.toContain('"project"');
  });

  it('reads "in total" as the whole record', () => {
    expect(JSON.stringify(params('how many todos are there for labs in total?'))).not.toContain(
      'archived'
    );
  });

  it('reads "the current <singular>" as the latest', () => {
    expect(params('what is the current session?')).toMatchObject({
      orderBy: [{ createdAt: 'desc' }],
      limit: 1
    });
  });
});

describe('inline field clauses (the mini-DSL)', () => {
  it("parses the operator's example: words plus a field clause", () => {
    const r = parse("show me todos closed in the past month that are 'project:[substrate,labs]'");
    expect(r.status).toBe('resolved');
    expect(
      params("show me todos closed in the past month that are 'project:[substrate,labs]'")
    ).toEqual({
      where: {
        AND: [
          { project: { in: ['substrate', 'labs'] } },
          { updatedAt: { gte: '2026-09-02T00:00:00-05:00', lt: '2026-10-03T00:00:00-05:00' } },
          { status: { in: ['done', 'closed'] } }
        ]
      }
    });
  });

  it('supports eq, quoted values, comparisons, ranges, negation and contains', () => {
    const w = (q: string) => JSON.stringify(params(q));
    expect(w('todos area:recall')).toContain('{"area":{"eq":"recall"}}');
    expect(w('todos title:"fix the build"')).toContain('{"title":{"eq":"fix the build"}}');
    expect(w('todos shortId:>1500')).toContain('{"shortId":{"gt":1500}}');
    expect(w('todos shortId:1000..1100')).toContain('{"shortId":{"between":[1000,1100]}}');
    expect(w('todos priority:!low')).toContain('{"priority":{"neq":"low"}}');
    expect(w('todos title:~embed')).toContain('{"title":{"contains":"embed"}}');
  });

  it('infers the type from the fields named when no type word is given', () => {
    expect(Object.keys(parse('severity:must').candidates[0]?.frame ?? {})).toEqual([
      'ns/AgentRule'
    ]);
  });

  it('rules out a reading whose type lacks the field, and refuses an operator the field does not accept', () => {
    expect(parse('decisions priority:high').status).toBe('unparsed');
    const bad = parse('todos archived:~yes');
    expect(bad.status).toBe('unparsed');
    expect(bad.reason).toContain('contains');
  });

  it('does not read a clock time as a clause', () => {
    expect(parse('what is open at 12:30').status).not.toBe('unparsed');
  });
});

describe('rolling windows', () => {
  it('reads "past <unit>" and "last N days" as rolling, ending today', () => {
    const asOf = '2026-10-02T12:00:00-05:00';
    expect(rangeFor('past week', asOf)).toEqual({
      gte: '2026-09-25T00:00:00-05:00',
      lt: '2026-10-03T00:00:00-05:00'
    });
    expect(rangeFor('past month', asOf)).toEqual({
      gte: '2026-09-02T00:00:00-05:00',
      lt: '2026-10-03T00:00:00-05:00'
    });
    expect(rangeFor('last 3 days', asOf)).toEqual({
      gte: '2026-09-29T00:00:00-05:00',
      lt: '2026-10-03T00:00:00-05:00'
    });
  });
});

describe('terminal states and field stems (eval findings)', () => {
  it('keeps "superseded" as a status value, not a closing verb', () => {
    expect(JSON.stringify(params('which decisions have been superseded?'))).toContain(
      '{"status":{"eq":"superseded"}}'
    );
  });

  it('does not count deferred as closed', () => {
    const pk = buildNamespacePack({
      namespace: 'ns',
      operators: OPERATORS,
      schema: {
        schemaVersion: 'v',
        mutations: {},
        types: {
          Todo: {
            fields: {
              status: {
                kind: 'scalar',
                type: 'string',
                indexed: true,
                enum: ['open', 'done', 'deferred']
              }
            }
          }
        }
      }
    });
    expect(
      JSON.stringify(parseQuestion('todos closed today', pk, ctx).candidates[0]?.frame)
    ).toContain('{"status":{"in":["done"]}}');
  });

  it('lets an inflected field word pick the field ("tagged recall" -> tags, not area)', () => {
    // area is the more categorical field here, so without the stem rule it would win.
    const pk = buildNamespacePack({
      namespace: 'ns',
      operators: OPERATORS,
      schema: {
        schemaVersion: 'v',
        mutations: {},
        types: { Todo: { fields: { area: s(), tags: { kind: 'list', of: s(), indexed: true } } } }
      },
      profile: {
        types: {
          Todo: {
            area: { values: ['recall', 'ops'], truncated: false },
            tags: { values: ['recall', 'a', 'b', 'c', 'd'], truncated: false }
          }
        }
      }
    });
    const r = parseQuestion('which todos are tagged recall?', pk, ctx);
    expect(JSON.stringify(r.candidates[0]?.frame)).toContain('{"tags":{"has":"recall"}}');
    expect(r.status).toBe('resolved');
  });
});

describe('live status (operator ruling 1, as data)', () => {
  const two = buildNamespacePack({
    namespace: 'ns',
    operators: OPERATORS,
    schema: {
      schemaVersion: 'v',
      mutations: {},
      types: {
        Todo: { fields: { status: s({ enum: ['open', 'closed'] }), project: s() } },
        Decision: { fields: { status: s({ enum: ['open', 'active'] }), project: s() } }
      }
    },
    profile: { types: { Todo: { project: { values: ['substrate'], truncated: false } } } }
  });
  const where = (q: string, rulings: NamespaceRulings = { liveStatus: { Todo: 'open' } }) =>
    JSON.stringify(
      Object.values(parseQuestion(q, two, { ...ctx, rulings }).candidates[0]?.frame ?? {})[0]
        ?.params
    );

  it('defaults only the types the ruling names: decisions are not filtered to open', () => {
    expect(where('show the todos')).toContain('{"status":{"eq":"open"}}');
    expect(where('show the decisions')).not.toContain('"status"');
  });

  it('has no default at all without the ruling', () => {
    expect(where('show the todos', { liveStatus: {} })).not.toContain('"status"');
  });

  it('reads a bare live word as the type it is the live state of', () => {
    const r = parseQuestion("what's open", two, {
      ...ctx,
      rulings: { liveStatus: { Todo: 'open' } }
    });
    expect(r.status).toBe('resolved');
    expect(r.candidates.map((c) => c.type)).toEqual(['Todo']);
  });

  it('still reads "open decisions" as decisions', () => {
    const r = parseQuestion('open decisions', two, {
      ...ctx,
      rulings: { liveStatus: { Todo: 'open' } }
    });
    expect(r.candidates.map((c) => c.type)).toEqual(['Decision']);
  });
});

describe('outcome verbs close the question', () => {
  it.each(['ship', 'drop'])(
    '"what did we %s this week" is about finished work, dated by updatedAt',
    (verb) => {
      const p = JSON.stringify(
        Object.values(
          parseQuestion(`what did we ${verb} this week`, pack, ctx).candidates[0]?.frame ?? {}
        )[0]?.params
      );
      expect(p).toContain('"updatedAt"');
      expect(p).not.toContain('{"status":{"eq":"open"}}');
      expect(p).not.toContain('"archived"');
    }
  );
});

describe('time field ruling', () => {
  it('dates a type by its ruled field, and createdAt otherwise', () => {
    const p = (q: string, timeField?: Record<string, string>) =>
      JSON.stringify(
        Object.values(
          parseQuestion(q, pack, {
            ...ctx,
            rulings: { ...ctx.rulings, ...(timeField ? { timeField } : {}) }
          }).candidates[0]?.frame ?? {}
        )[0]?.params
      );
    expect(p('sessions yesterday', { SessionLog: 'startedAt' })).toContain('"startedAt"');
    expect(p('sessions yesterday')).toContain('"createdAt"');
  });
});
