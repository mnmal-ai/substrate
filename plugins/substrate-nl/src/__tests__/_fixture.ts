import type { Schema } from '@mnmal-ai/substrate/sdk';
import { buildNamespacePack } from '../pack/build.js';
import type { NamespaceRulings } from '../pack/rulings.js';

export const OPERATORS = {
  'scalar.string': ['contains', 'eq', 'in', 'neq', 'startsWith'],
  'scalar.number': ['between', 'eq', 'gt', 'in'],
  'scalar.boolean': ['eq'],
  'scalar.date': ['gte', 'lt'],
  crossRef: ['eq'],
  list: ['has']
};
export const s = (extra: object = {}) => ({
  kind: 'scalar' as const,
  type: 'string' as const,
  indexed: true,
  ...extra
});
const schema: Schema = {
  schemaVersion: 'v',
  mutations: {},
  types: {
    Todo: {
      fields: {
        title: s(),
        status: s({ enum: ['open', 'done', 'closed', 'blocked'] }),
        priority: s({ enum: ['low', 'medium', 'high'] }),
        project: s(),
        area: s(),
        tags: { kind: 'list', of: s(), indexed: true },
        targetDate: { kind: 'scalar', type: 'date', indexed: true },
        archived: { kind: 'scalar', type: 'boolean', indexed: true },
        shortId: { kind: 'scalar', type: 'number', indexed: true }
      }
    },
    AgentIdentity: {
      fields: {
        kid: s(),
        project: s(),
        host: s(),
        active: { kind: 'scalar', type: 'boolean', indexed: true }
      }
    },
    SessionLog: { fields: { project: s() } },
    CouncilSession: { fields: { project: s() } },
    Decision: {
      fields: {
        project: s(),
        status: s(),
        archived: { kind: 'scalar', type: 'boolean', indexed: true }
      }
    },
    AgentRule: {
      fields: {
        severity: s({ enum: ['must', 'should', 'high'] }),
        project: s(),
        pinned: { kind: 'scalar', type: 'boolean', indexed: true },
        active: { kind: 'scalar', type: 'boolean', indexed: true }
      }
    },
    AnchorIntent: { fields: { project: s() } }
  }
};
export const pack = buildNamespacePack({
  namespace: 'ns',
  schema,
  operators: OPERATORS,
  profile: {
    types: {
      Todo: {
        project: { values: ['labs', 'substrate'], truncated: false },
        area: { values: ['substrate', 'recall', 'ops', 'auth'], truncated: false },
        tags: { values: ['recall', 'release'], truncated: false }
      },
      Decision: {
        project: { values: ['substrate', 'holomap'], truncated: false },
        status: { values: ['active', 'accepted', 'superseded'], truncated: false }
      },
      AgentIdentity: { host: { values: ['laptop', 'devbox'], truncated: false } }
    }
  }
});
export const rulings: NamespaceRulings = {
  unscopedTypes: ['AgentIdentity'],
  liveStatus: { Todo: 'open' },
  typeAliases: { sessions: 'SessionLog', agents: 'AgentIdentity' },
  fieldAliases: { repo: 'project' },
  valueAliases: {
    accepted: [{ type: 'Decision', field: 'status', in: ['active', 'accepted'] }],
    'signal-gated': [{ type: 'Todo', field: 'title', startsWith: '[SG]' }]
  }
};
export const ctx = {
  project: 'substrate',
  asOf: '2026-10-02T12:00:00-05:00',
  defaultIdType: 'Todo',
  rulings
};
export const SCOPE = { OR: [{ project: { eq: 'substrate' } }, { project: { eq: null } }] };
