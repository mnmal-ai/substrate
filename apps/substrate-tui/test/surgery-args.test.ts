import { AdminBackfillError, AuthError, NetworkError } from '@mnmal-ai/substrate/client';
import { describe, expect, it } from 'vitest';
import { refusalOf } from '../src/admin/refusal.js';
import { parseOp, targetOf } from '../src/surgery/args.js';

describe('parseOp', () => {
  it('drop-namespace, with and without --cascade', () => {
    expect(parseOp('drop-namespace', ['scratch'])).toEqual({
      kind: 'drop-namespace',
      namespace: 'scratch',
      cascade: false
    });
    expect(parseOp('drop-namespace', ['scratch', '--cascade'])).toEqual({
      kind: 'drop-namespace',
      namespace: 'scratch',
      cascade: true
    });
  });
  it('drop-type takes <ns>/<Type>', () => {
    expect(parseOp('drop-type', ['journal/Foo'])).toEqual({
      kind: 'drop-type',
      namespace: 'journal',
      type: 'Foo',
      cascade: false
    });
    expect(parseOp('drop-type', ['journal'])).toHaveProperty('error');
  });
  it('backfill takes <ns>/<Type>.<field> --values <file> [--overwrite]', () => {
    expect(
      parseOp('backfill', ['journal/Todo.resolution', '--values', '~/v.json', '--overwrite'])
    ).toEqual({
      kind: 'backfill',
      namespace: 'journal',
      type: 'Todo',
      field: 'resolution',
      valuesPath: '~/v.json',
      overwrite: true
    });
    expect(parseOp('backfill', ['journal/Todo.resolution'])).toHaveProperty('error');
  });
  it('normalise takes --reject a,b', () => {
    expect(parseOp('normalise', ['journal/Todo.status', '--reject', 'zombie,ghost'])).toEqual({
      kind: 'normalise',
      namespace: 'journal',
      type: 'Todo',
      field: 'status',
      reject: ['zombie', 'ghost']
    });
    expect(parseOp('normalise', ['journal/Todo.status'])).toMatchObject({ reject: [] });
  });
  it('reindex takes zero or more <ns>/<Type>', () => {
    expect(parseOp('reindex', [])).toEqual({ kind: 'reindex', targets: [] });
    expect(parseOp('reindex', ['journal/Memory', 'journal/Decision'])).toEqual({
      kind: 'reindex',
      targets: [
        { namespace: 'journal', type: 'Memory' },
        { namespace: 'journal', type: 'Decision' }
      ]
    });
    expect(parseOp('reindex', ['journal'])).toHaveProperty('error');
  });
  it('refuses an unknown flag and a missing subject', () => {
    expect(parseOp('drop-namespace', [])).toHaveProperty('error');
    expect(parseOp('drop-namespace', ['n', '--force'])).toEqual({
      error: "unknown flag '--force' for /drop-namespace"
    });
  });
  it('--values with no value is the usage error', () => {
    const usage = {
      error: 'usage: /backfill <ns>/<Type>.<field> --values <file.json> [--overwrite]'
    };
    expect(parseOp('backfill', ['n/T.f', '--values'])).toEqual(usage);
    expect(parseOp('backfill', ['n/T.f', '--values', '--overwrite'])).toEqual(usage);
  });
  it('an invalid namespace is the usage error', () => {
    expect(parseOp('drop-namespace', ['9bad'])).toEqual({
      error: 'usage: /drop-namespace <ns> [--cascade]'
    });
    expect(parseOp('drop-type', ['bad ns/T'])).toHaveProperty('error');
  });
  it.each([
    ['drop-namespace', ['n', '--cascade', '--cascade'], '--cascade'],
    ['drop-type', ['n/T', '--cascade', '--cascade'], '--cascade'],
    ['backfill', ['n/T.f', '--values', 'a.json', '--values', 'b.json'], '--values'],
    ['backfill', ['n/T.f', '--values', 'a.json', '--overwrite', '--overwrite'], '--overwrite'],
    ['normalise', ['n/T.f', '--reject', 'a', '--reject', 'b'], '--reject']
  ] as const)('/%s refuses a flag given twice', (command, args, flag) => {
    expect(parseOp(command, args)).toEqual({
      error: `flag '${flag}' given twice for /${command}`
    });
  });
  it('reindex refuses a target named twice', () => {
    expect(parseOp('reindex', ['journal/Memory', 'journal/Decision', 'journal/Memory'])).toEqual({
      error: 'journal/Memory named twice'
    });
  });
  it.each([
    ['drop-namespace', ['_system']],
    ['drop-namespace', ['_system', '--cascade']],
    ['drop-type', ['_system/AuditEvent']]
  ] as const)('/%s %j refuses _system locally', (command, args) => {
    expect(parseOp(command, args)).toEqual({
      error: "_system is the deployment's own namespace and cannot be dropped"
    });
  });
});

describe('targetOf', () => {
  it('is the subject, or the word reindex', () => {
    expect(targetOf({ kind: 'drop-namespace', namespace: 'n', cascade: true })).toBe('n');
    expect(targetOf({ kind: 'drop-type', namespace: 'n', type: 'T', cascade: false })).toBe('n/T');
    expect(targetOf({ kind: 'normalise', namespace: 'n', type: 'T', field: 'f', reject: [] })).toBe(
      'n/T.f'
    );
    expect(targetOf({ kind: 'reindex', targets: [] })).toBe('reindex');
  });
});

describe('refusalOf', () => {
  it('keeps the body of a coded refusal', () => {
    const e = new NetworkError('409', null, {
      status: 409,
      code: 'dangling_edges',
      serverMessage: 'm',
      body: { edgeCount: 3 }
    });
    expect(refusalOf(e)).toEqual({ code: 'dangling_edges', message: 'm', body: { edgeCount: 3 } });
  });
  it('an AuthError without a code falls back to its status', () => {
    expect(refusalOf(new AuthError('Forbidden', 403))).toMatchObject({ code: '403' });
  });
  it('unwraps an AdminBackfillError to its cause', () => {
    const cause = new NetworkError('400', null, {
      status: 400,
      code: 'invalid_values',
      serverMessage: 'bad',
      body: { invalid: [] }
    });
    const partial = {
      requested: 1,
      write: 0,
      kept: 0,
      unchanged: 0,
      missing: [],
      counts: {},
      applied: true,
      chunks: 1
    };
    expect(refusalOf(new AdminBackfillError(cause, 0, 1, partial))).toMatchObject({
      code: 'invalid_values',
      message: 'bad'
    });
  });
});
