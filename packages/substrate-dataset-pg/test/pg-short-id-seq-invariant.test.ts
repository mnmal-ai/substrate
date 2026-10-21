/**
 * Pure-logic tests for `seqName`. No POSTGRES_URL needed.
 */

import { describe, expect, it } from 'vitest';
import { seqName } from '../src/pg-short-id-store.js';

describe('seqName', () => {
  it('keeps the established names, so existing sequences are not restarted', () => {
    expect(seqName('claude', 'Todo')).toBe('claude__todo_short_id_seq');
    expect(seqName('architecture', 'ArchitectureConcern')).toBe(
      'architecture__architectureconcern_short_id_seq'
    );
  });

  // A shared sequence only leaves gaps (short_ids is keyed by ns, type,
  // short_id), so these must name a sequence rather than refuse. The control
  // plane `_system_proposals` is one.
  it('names a sequence for underscore-led, -trailed and doubled names', () => {
    expect(seqName('_system_proposals', 'NamespaceProposal')).toBe(
      '_system_proposals__namespaceproposal_short_id_seq'
    );
    expect(() => seqName('foo_', 'bar')).not.toThrow();
    expect(() => seqName('foo__x', '_bar_')).not.toThrow();
  });
});
