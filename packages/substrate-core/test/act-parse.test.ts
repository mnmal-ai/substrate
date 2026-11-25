import type { ActStep } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { formatSketch, formatStep, parseSketch } from '../src/act/parse.js';

const cases: Array<[string, ActStep[]]> = [
  ['close Todo #2014', [{ action: 'close', type: 'Todo', refs: ['#2014'] }]],
  [
    'close Todo #2014 #2015 resolution=wont_do',
    [{ action: 'close', type: 'Todo', refs: ['#2014', '#2015'], args: { resolution: 'wont_do' } }]
  ],
  [
    'close Todo #17,#20 [#21,#22] [#23] #24',
    [{ action: 'close', type: 'Todo', refs: ['#17', '#20', '#21', '#22', '#23', '#24'] }]
  ],
  [
    'log SessionLog summary="Shipped beta.9" closes=#2014,#2015',
    [
      {
        action: 'log',
        type: 'SessionLog',
        args: { summary: 'Shipped beta.9', closes: ['#2014', '#2015'] }
      }
    ]
  ],
  [
    'create Todo title="x" as $t; update Todo $t priority=high',
    [
      { action: 'create', type: 'Todo', args: { title: 'x' }, as: 't' },
      { action: 'update', type: 'Todo', refs: ['$t'], args: { priority: 'high' } }
    ]
  ],
  [
    'update cortext/Todo 3f2a-uuid notes=null',
    [{ action: 'update', type: 'cortext/Todo', refs: ['3f2a-uuid'], args: { notes: null } }]
  ],
  [
    'log SessionLog summary="a; b, c #1" branch=x',
    [{ action: 'log', type: 'SessionLog', args: { summary: 'a; b, c #1', branch: 'x' } }]
  ],
  [
    'create Note body="say \\"hi\\"\\nbye"',
    [{ action: 'create', type: 'Note', args: { body: 'say "hi"\nbye' } }]
  ],
  [
    'find Todo status=open,blocked',
    [{ action: 'find', type: 'Todo', args: { status: ['open', 'blocked'] } }]
  ],
  [
    'log SessionLog closes=[#1] tags=[a,b] none=[]',
    [{ action: 'log', type: 'SessionLog', args: { closes: ['#1'], tags: ['a', 'b'], none: [] } }]
  ],
  [
    'create Note title="[x]" body=[y',
    [{ action: 'create', type: 'Note', args: { title: '[x]', body: '[y' } }]
  ],
  [
    'define work/Todo.reopen reopened status=open owner=$who?',
    [
      {
        action: 'define',
        type: 'work/Todo.reopen',
        refs: ['reopened'],
        args: { status: 'open', owner: '$who?' }
      }
    ]
  ],
  ['?', [{ action: '?' }]],
  ['? Todo', [{ action: '?', type: 'Todo' }]]
];

describe('parseSketch', () => {
  it.each(cases)('parses %s', (text, steps) => {
    expect(parseSketch(text)).toMatchObject({ steps });
  });

  it('records each step text', () => {
    expect(parseSketch(' close Todo #1 ;\n\n count Todo ')).toMatchObject({
      texts: ['close Todo #1', 'count Todo']
    });
  });

  it('reads a bare empty value as null and a quoted one as the empty string', () => {
    expect(parseSketch('update Todo #1 blockedBy= notes=""')).toMatchObject({
      steps: [{ args: { blockedBy: null, notes: '' } }]
    });
  });

  it('offers the action first for a step that leads with Type.word', () => {
    expect(parseSketch('count Todo; Todo.unblock #6 notes="a b"')).toEqual({
      refusal: {
        code: 'sketch_unresolved',
        step: 2,
        token: 'Todo.unblock',
        problem: 'bad action: the action comes before the type',
        choices: [],
        nearest: 'count Todo; unblock Todo #6 notes="a b"'
      }
    });
  });

  it('keeps a newline inside quotes in one step', () => {
    expect(parseSketch('create Note body="a\nb"')).toMatchObject({
      steps: [{ args: { body: 'a\nb' } }]
    });
  });

  it.each([
    ['', 1, 'empty sketch'],
    [' ; \n', 1, 'empty sketch'],
    ['close Todo title="open', 1, 'unterminated quote'],
    ['close Todo #1 as t', 1, 'as needs $name'],
    ['close Todo #1; close Todo a=1 a=2', 2, "duplicate arg 'a'"],
    ['close', 1, 'missing type'],
    ['? Todo extra', 1, 'help takes at most a type'],
    ['close Todo #1,', 1, 'unexpected token'],
    ['close Todo []', 1, 'unexpected token'],
    ['close Todo #1,"#2"', 1, 'unexpected token']
  ])('refuses %j', (text, step, problem) => {
    expect(parseSketch(text)).toEqual({
      refusal: {
        code: 'sketch_unresolved',
        step,
        token: expect.any(String),
        problem,
        choices: [],
        nearest: null
      }
    });
  });
});

describe('formatSketch', () => {
  it.each(cases)('round-trips %s', (text, steps) => {
    const parsed = parseSketch(text);
    if (!('steps' in parsed)) throw new Error('parse failed');
    expect(parseSketch(formatSketch(parsed.steps))).toMatchObject({ steps });
  });

  it('quotes values that need it', () => {
    expect(formatStep({ action: 'create', type: 'Todo', args: { title: 'a b' } })).toBe(
      'create Todo title="a b"'
    );
    const step: ActStep = {
      action: 'create',
      type: 'T',
      args: { a: '', b: 'null', c: 'x"y\\z', d: null }
    };
    expect(formatStep(step)).toBe('create T a="" b="null" c="x\\"y\\\\z" d=null');
    expect(parseSketch(formatStep(step))).toMatchObject({ steps: [step] });
  });
});
