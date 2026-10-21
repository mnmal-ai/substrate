/**
 * Bootstrap tests for the substrate-proposals control-plane namespace.
 *
 * The plugin reserves `substrate_proposals` to house the
 * NamespaceProposal autoCRUD type. This test pins two contracts:
 *   1. The control-plane ns is auto-installed alongside any user-facing
 *      ownedNamespaces.
 *   2. Passing the control-plane ns name in `ownedNamespaces` is rejected at
 *      construction (the name is reserved).
 */

import { describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { createNoopPubSub, createProposalsPlugin } from '../src/index.js';

describe('substrate-proposals control-plane bootstrap', () => {
  it('auto-installs the control-plane namespace alongside ownedNamespaces', () => {
    const plugin = createProposalsPlugin({
      ownedNamespaces: ['sandbox'],
      pubsub: createNoopPubSub()
    });
    const namespaceNames = plugin.namespaces.map((n) => n.namespace).sort();
    expect(namespaceNames).toEqual([CONTROL_NAMESPACE, 'sandbox']);
  });

  it('rejects when user passes the control-plane namespace as owned', () => {
    expect(() =>
      createProposalsPlugin({
        ownedNamespaces: [CONTROL_NAMESPACE],
        pubsub: createNoopPubSub()
      })
    ).toThrow(/reserved/i);
  });
});
