/**
 * pg NOTICEs go to stderr, never stdout.
 *
 * The `postgres` package's default NOTICE handler `console.log`s the whole
 * notice object to STDOUT. Every CLI path that opens a pg client runs
 * migrations first, so their `already exists, skipping` notices would land
 * ahead of output a script parses, such as `substrate federate enroll`'s token.
 */

import { describe, expect, it } from 'vitest';
import { pgNoticeOptions } from '../src/pg-client.js';

describe('pg notice routing', () => {
  it('routes notices to the injected sink instead of stdout', () => {
    const written: Array<string> = [];
    const opts = pgNoticeOptions((s) => written.push(s));
    opts.onnotice({ severity: 'NOTICE', message: 'relation "x" already exists, skipping' });
    expect(written).toEqual(['pg notice: relation "x" already exists, skipping\n']);
  });

  it('collapses a notice to one line rather than dumping the object', () => {
    const written: Array<string> = [];
    const opts = pgNoticeOptions((s) => written.push(s));
    opts.onnotice({
      severity_local: 'NOTICE',
      severity: 'NOTICE',
      code: '42P07',
      message: 'relation "migrations" already exists, skipping',
      file: 'parse_utilcmd.c',
      line: '207',
      routine: 'transformCreateStmt'
    });
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain('parse_utilcmd.c');
    expect(written[0]).toContain('migrations');
  });

  it('degrades to a readable line when the notice is not the expected shape', () => {
    const written: Array<string> = [];
    const opts = pgNoticeOptions((s) => written.push(s));
    opts.onnotice('something unstructured');
    expect(written).toEqual(['pg notice: something unstructured\n']);
  });
});
