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
    },
    // The store then holds 3,000 events, as a busy week would. One in fifty is still open.
    fill: {
      namespace: 'ops',
      type: 'Event',
      field: 'status',
      value: 'open',
      otherwise: 'closed',
      every: 50,
      rows: 3000
    }
  },
  {
    label: 'Read open events, 20 times: each read is recorded and none is served by an index',
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
    method: 'POST',
    as: 'ops-agent',
    path: '/substrate/v1/query',
    body: openEvents
  }
];
