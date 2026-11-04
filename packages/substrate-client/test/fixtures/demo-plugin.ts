/**
 * Local test fixture — a `demoPlugin` coordinator contributing the
 * `default/...` types the integration suite queries.
 *
 * Types contributed:
 *   - `Todo`         — autoCRUD
 *   - `Tag`          — autoCRUD with crossRef to Todo (onDelete: 'set_null')
 *   - `streamTodos`  — generator resolver (1ms delay between chunks)
 */

import { installAutoCrud } from '@mnmal-ai/substrate-sdk';
import type {
  CoordinatorPlugin,
  FieldDef,
  NamespaceInstallContext
} from '@mnmal-ai/substrate-types';

export const DEMO_NAMESPACE = 'default';

const todoFields: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string', indexed: true },
  title: { kind: 'scalar', type: 'string', indexed: true },
  done: { kind: 'scalar', type: 'boolean', indexed: true, default: false },
  // Deliberately unindexed: filters on it are accepted all the same.
  priority: { kind: 'scalar', type: 'number', default: 0 },
  // Engine-allocated sequence number per (ns, type).
  shortId: { kind: 'scalar', type: 'number', indexed: true, readonly: true },
  archived: { kind: 'scalar', type: 'boolean', indexed: true, default: false },
  // `nullable: true` so `where { project: { in: ['substrate', null] } }` passes the
  // engine validator — null elements inside in/nin are otherwise rejected.
  project: { kind: 'scalar', type: 'string', indexed: true, nullable: true },
  status: { kind: 'scalar', type: 'string', enum: ['open', 'done'], nullable: true }
};

async function installDemoNamespace(ctx: NamespaceInstallContext): Promise<void> {
  const { registry, dataset, edges } = ctx;

  installAutoCrud(registry, 'Todo', dataset, edges, { fields: todoFields });

  installAutoCrud(registry, 'Tag', dataset, edges, {
    fields: {
      id: { kind: 'scalar', type: 'string', indexed: true },
      label: { kind: 'scalar', type: 'string', indexed: true },
      todoId: { kind: 'crossRef', ns: DEMO_NAMESPACE, type: 'Todo', onDelete: 'set_null' }
    }
  });

  registry.register('streamTodos', {
    kind: 'type',
    fields: todoFields,
    resolver: async function* (_ctx, args) {
      const { signal } = args;
      const source = args.dataset ?? dataset;
      const result = await source.read('Todo', {});
      for (const row of result.rows) {
        if (signal?.aborted) return;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1);
          timer.unref?.();
          if (signal !== undefined) {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        yield row;
      }
    }
  });
}

export const demoPlugin: CoordinatorPlugin = {
  name: 'demo',
  contractVersion: '*',
  namespaces: [{ namespace: DEMO_NAMESPACE, install: installDemoNamespace }]
};
