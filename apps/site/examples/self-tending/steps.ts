import type { Step } from '../_harness.ts';

// The advisor derives this id from the read's shape, so it is the same on every run.
const RECOMMENDATION = 'd2166985-8422-8be1-b527-e22959757d98';

const openEvents = {
  'ops/Event': {
    params: { where: { status: { eq: 'open' } }, limit: 5 },
    fields: { id: true, source: true, status: true }
  }
};

export const steps: Step[] = [
  {
    label: 'Propose ops/Event, a type expected to grow large',
    method: 'POST',
    as: 'ops-agent',
    path: '/substrate/v1/mutate',
    body: {
      'ops/propose_type': {
        params: {
          typeName: 'Event',
          fields: {
            source: { kind: 'scalar', type: 'string' },
            status: { kind: 'scalar', type: 'string' }
          },
          proposedReason: 'Operational events, read by status',
          expectedSize: 'large'
        },
        fields: { id: true }
      }
    }
  },
  {
    label:
      'Demo setup: seed 3,000 closed and 3 open events straight into the store, then ANALYZE. This is simulated load, not traffic',
    method: 'POST',
    path: '/substrate/v1/query',
    as: 'ops-agent',
    fill: {
      namespace: 'ops',
      type: 'Event',
      field: 'status',
      value: 'open',
      otherwise: 'closed',
      rows: 3000,
      matching: 3
    },
    body: { 'ops/Event': { params: { limit: 1 }, fields: { id: true, status: true } } }
  },
  {
    label:
      'Demo: this run delays every read of ops by 60 ms, so the advisor sees a slow shape quickly. Read open events 20 times; none is served by an index',
    slow: 60,
    method: 'POST',
    as: 'ops-agent',
    path: '/substrate/v1/query',
    repeat: 20,
    body: openEvents
  },
  {
    label: 'Read the advisor’s recommendations',
    method: 'POST',
    as: 'ops-agent',
    path: '/substrate/v1/query',
    advise: true,
    body: {
      '_system/IndexRecommendation': {
        params: { where: { namespace: { eq: 'ops' } } },
        fields: { id: true, type: true, action: true, state: true, declarationJson: true }
      }
    }
  },
  {
    label: 'Approve it: propose_index add, sent alone',
    method: 'POST',
    as: 'ops-agent',
    path: '/substrate/v1/mutate',
    body: {
      '_system_proposals/propose_index': {
        params: {
          namespace: 'ops',
          type: 'Event',
          action: 'add',
          recommendationId: RECOMMENDATION,
          reason: 'Open events are read constantly and every read scans the table'
        },
        fields: { id: true }
      }
    }
  },
  {
    label: 'Read open events again: the same frame, now served by the index',
    explain: true,
    method: 'POST',
    as: 'ops-agent',
    path: '/substrate/v1/query',
    body: openEvents
  }
];
