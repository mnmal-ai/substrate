import { createAdminSession } from '../src/admin/session.js';
import type { TuiDeps } from '../src/deps.js';

/** The dash's sources, unreachable: for fakes whose tests never open /dash. */
export const noDash: Pick<TuiDeps, 'metrics' | 'errors'> = {
  metrics: async () => {
    throw new Error('no metrics');
  },
  errors: async () => {
    throw new Error('no errors');
  }
};

/** Admin members for fakes whose tests never unlock. */
export const noAdmin = (): Pick<TuiDeps, 'admin' | 'adminEnv' | 'agentAuthorization' | 'keys'> => ({
  admin: createAdminSession({ endpoint: 'http://h', idleMs: 60_000 }),
  adminEnv: {},
  agentAuthorization: null,
  keys: async () => {
    throw new Error('no keys');
  }
});
