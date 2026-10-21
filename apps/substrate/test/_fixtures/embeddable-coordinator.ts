/**
 * Minimal embeddable coordinator fixture for the cross-plugin recall tests.
 *
 * Unlike `fixture-plugin.ts` (imperative `installAutoCrud`, used by the
 * cross-server-parity gate), these tests exercise the AUTO-EMBED chain:
 * substrate-recall's `contributePostWrites` scans coordinator namespaces for types
 * carrying `embed.source` and chains an embedding postWrite. That scan reads the
 * namespace's `types` record, so the embeddable type must be declared via
 * `defineNamespace` (which exposes `types`), not bare `installAutoCrud`.
 *
 * Types:
 *   - `Memo` — embeddable (`embed.source` on `body`)
 *   - `Item` — non-embeddable (the "write produces no embedding" path)
 */

import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';

export const EMBEDDABLE_NS = 'sample';

export const embeddableCoordinator: CoordinatorPlugin = {
  name: 'sample-coordinator',
  contractVersion: '*',
  namespaces: [
    defineNamespace(EMBEDDABLE_NS, {
      Memo: {
        fields: {
          name: field.string(),
          description: field.string(),
          type: field.string({ nullable: true }),
          body: field.string({ nullable: true, indexed: false }),
          // Self-referential spread crossRef — recall's spreadRegistry walks it
          // for the recall-frame-parity expansion test.
          relatedTo: field.crossRef(EMBEDDABLE_NS, 'Memo', { nullable: true, spread: true }),
          archived: field.boolean({ default: false }),
          project: field.string({ nullable: true })
        },
        embed: {
          source: (r) => (typeof r.body === 'string' ? r.body : '')
        }
      },
      Item: {
        fields: {
          title: field.string(),
          area: field.string({ nullable: true }),
          status: field.string({ nullable: true }),
          priority: field.string({ nullable: true }),
          archived: field.boolean({ default: false }),
          project: field.string({ nullable: true })
        }
      }
    })
  ]
};
