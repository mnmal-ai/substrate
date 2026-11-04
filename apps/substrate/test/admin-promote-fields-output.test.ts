/**
 * `substrate-admin promote-fields` prints one line per field the sweep
 * touched, including one it skipped because another process was sweeping it.
 */

import { describe, expect, it } from 'vitest';
import { formatPromoteFieldsOutput } from '../src/admin/commands/promote-fields.js';

describe('promote-fields output', () => {
  it('names a field held by another process as busy, without an attempt', () => {
    const out = formatPromoteFieldsOutput({
      target: 'promote-fields: targeting http://127.0.0.1:3100',
      events: [
        { kind: 'promoted', namespace: 'app', type: 'Note', field: 'a', attempts: 1 },
        {
          kind: 'busy',
          namespace: 'app',
          type: 'Note',
          field: 'b',
          attempts: 0,
          error: 'held by another process'
        },
        { kind: 'busy', namespace: 'app', type: 'Note', field: 'c', attempts: 2 }
      ]
    });
    expect(out).toBe(
      [
        'promote-fields: targeting http://127.0.0.1:3100',
        'app/Note.a: promoted (attempt 1)',
        'app/Note.b: busy (held by another process)',
        'app/Note.c: busy (attempt 2)',
        ''
      ].join('\n')
    );
  });
});
