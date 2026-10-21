/**
 * substrate-sentinel namespace definition.
 *
 * Three autoCRUD types: Coordinator, CoordinatorNamespace, CoordinatorBridge.
 * The WS handler composes upsert on top of create/update.
 *
 * `coordinatorId` fields are plain string scalars rather than `field.crossRef`;
 * the §6.1 edge wiring for this surface is deferred.
 */

import type { NamespaceDefinition } from '@mnmal-ai/substrate/sdk';
import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

export function buildSentinelNamespace(ns: string): NamespaceDefinition {
  return defineNamespace(ns, {
    Coordinator: {
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

/** The canonical ordered list of type names registered by this namespace. */
export const SENTINEL_TYPE_NAMES = [
  'Coordinator',
  'CoordinatorNamespace',
  'CoordinatorBridge'
] as const;
