/**
 * substrate-sentinel namespace definition.
 *
 * Three autoCRUD types: Coordinator, CoordinatorNamespace, CoordinatorBridge.
 * `handleRegister` composes upsert on top of create/update.
 *
 * `coordinatorId` fields are plain string scalars rather than `field.crossRef`;
 * the §6.1 edge wiring for this surface is deferred.
 */

import type { NamespaceDefinition, Policy } from '@mnmal-ai/substrate/sdk';
import { defineNamespace, field, grantedIn, grantOf } from '@mnmal-ai/substrate/sdk';

/** The canonical ordered list of type names registered by this namespace. */
export const SENTINEL_TYPE_NAMES = [
  'Coordinator',
  'CoordinatorNamespace',
  'CoordinatorBridge'
] as const;

/**
 * `meta` key the register route sets on its own writes. A request from a
 * transport starts with an empty `meta`, so a caller cannot set it.
 */
export const REGISTER_WRITE = 'sentinelRegister';

/**
 * Reads are open to the namespace. Rows are written only by the register
 * route, which checks who owns a name and a url, or by a namespace admin.
 */
const registerWrites: Policy = (ctx) => {
  // A write probe names the type with operation 'mutate', so the name alone
  // does not make a read.
  const reads =
    ctx.verb === 'get' ||
    (ctx.operation !== 'mutate' &&
      (SENTINEL_TYPE_NAMES as readonly string[]).includes(ctx.entry ?? ''));
  if (reads || ctx.meta[REGISTER_WRITE] === true) return { allow: true };
  return grantedIn(grantOf(ctx.identity), ctx.namespace).includes('admin')
    ? { allow: true }
    : { allow: false, reason: 'coordinator rows are written through the register route' };
};

export function buildSentinelNamespace(ns: string): NamespaceDefinition {
  return defineNamespace(ns, {
    Coordinator: {
      policy: registerWrites,
      fields: {
        name: field.string(),
        url: field.string(),
        namespaces: field.string(),
        status: field.string(),
        lastHeartbeat: field.string(),
        registeredAt: field.string(),
        version: field.string()
      }
    },
    CoordinatorNamespace: {
      policy: registerWrites,
      fields: {
        // A `Coordinator`'s UUID string id. Must stay a string: a numeric type
        // makes every `where: { coordinatorId: { eq } }` reject.
        coordinatorId: field.string(),
        name: field.string(),
        typeCount: field.number(),
        schemaHash: field.string(),
        url: field.string()
      }
    },
    CoordinatorBridge: {
      policy: registerWrites,
      fields: {
        // UUID string id, as CoordinatorNamespace.coordinatorId.
        coordinatorId: field.string(),
        name: field.string(),
        targetUrl: field.string(),
        allowMutate: field.boolean(),
        allowPropose: field.boolean()
      }
    }
  });
}
