import * as sdk from '@mnmal-ai/substrate-sdk';
import { describe, expect, it } from 'vitest';

describe('public substrate-sdk exports', () => {
  it('exposes resolveIdentity for compose-layer raw-write callers', () => {
    expect(typeof sdk.resolveIdentity).toBe('function');
    // A null identity is refused, not defaulted.
    const result = sdk.resolveIdentity({
      identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } }
    });
    expect(result).toEqual({ kind: 'system', id: 'test' });
    // The export's contract includes the refusal, so pin that too.
    expect(typeof sdk.UnattributedWriteError).toBe('function');
    expect(() => sdk.resolveIdentity({ identity: null })).toThrow(sdk.UnattributedWriteError);
  });
});
