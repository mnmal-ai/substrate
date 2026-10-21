import type { RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROPOSE_CAPABILITY, makeProposePolicy } from '../src/capability.js';

describe('capability', () => {
  describe('makeProposePolicy', () => {
    it('allows when capability is granted', () => {
      const policy = makeProposePolicy();
      const ctx: RequestContext = {
        identity: {
          id: 'test-user',
          grants: { proposals: [DEFAULT_PROPOSE_CAPABILITY] }
        },
        namespace: 'proposals',
        operation: 'mutate',
        now: new Date(),
        headers: {},
        meta: {}
      };

      const decision = policy(ctx, {});
      expect(decision.allow).toBe(true);
    });

    it('denies when capability is missing', () => {
      const policy = makeProposePolicy();
      const ctx: RequestContext = {
        identity: {
          id: 'test-user',
          grants: { proposals: [] }
        },
        namespace: 'proposals',
        operation: 'mutate',
        now: new Date(),
        headers: {},
        meta: {}
      };

      const decision = policy(ctx, {});
      expect(decision.allow).toBe(false);
    });

    it('empty-string capability opts out of the gate (allow-all dev mode)', () => {
      const policy = makeProposePolicy('');
      const ctx: RequestContext = {
        identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
        namespace: 'proposals',
        operation: 'mutate',
        now: new Date(),
        headers: {},
        meta: {}
      };

      const decision = policy(ctx, {});
      expect(decision.allow).toBe(true);
    });
  });
});
