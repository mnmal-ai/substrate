/**
 * Onboard contribution for substrate-proposals. Returned verbatim by the
 * binary's `GET /substrate/v1/onboard` under
 * `instructions.plugins["substrate-proposals"]`, and served directly at
 * `GET /plugins/substrate-proposals/onboard` by `registerOnboardRoute`.
 *
 * Target reader: a cold-start agent that can see `propose_namespace`,
 * `propose_type`, and `propose_field` in the federated schema but doesn't
 * know when or how to reach for them. This body explains the workflow, the
 * wire shape, and the guardrails — enough for an LLM to compose a correct
 * call without reading plugin source.
 */

import { JSON_HEADERS } from '@mnmal-ai/substrate-compose';
import type {
  PluginRouteContext,
  PluginRouter,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { CONTROL_NAMESPACE } from './control-plane.js';

export interface OnboardBody {
  plugin: string;
  description: string;
  capability: string;
  whenToUse: string[];
  mutations: {
    propose_namespace: MutationDoc;
    propose_type: MutationDoc;
    propose_field: MutationDoc;
  };
  fieldSpecJson: {
    description: string;
    variants: Record<string, unknown>;
  };
  constraints: string[];
  collisions: Record<string, string>;
  examples: {
    addNewNamespace: Record<string, unknown>;
    addNewType: Record<string, unknown>;
    addFieldToExistingType: Record<string, unknown>;
    addCrossNamespaceEdge: Record<string, unknown>;
  };
}

interface MutationDoc {
  summary: string;
  frameKey: string;
  params: Record<string, string>;
  returns: Record<string, string>;
}

export function buildOnboardBody(ownedNamespaces: ReadonlyArray<string>): OnboardBody {
  return {
    plugin: 'substrate-proposals',
    description:
      'Lets authorised agents add new namespaces, new types, and new fields at runtime. ' +
      'Proposed namespaces and types become immediately queryable/mutatable via autoCRUD — ' +
      'no restart, no code change. The reserved control-plane namespace ' +
      `\`${CONTROL_NAMESPACE}\` is always installed; it houses the NamespaceProposal autoCRUD ` +
      'type that records every runtime namespace addition for audit + restart recovery. ' +
      'Statically-owned namespaces in this deployment: ' +
      (ownedNamespaces.length > 0
        ? ownedNamespaces.join(', ')
        : '(none — runtime-only via propose_namespace)'),
    capability:
      'Every propose_* call is gated by the `substrate.propose` capability on the caller identity ' +
      "(or the name set by the plugin's `proposeCapability` config). Without the capability, " +
      'the policy denies with code `policy_denied`.',
    whenToUse: [
      'Reach for propose_namespace when you need a brand-new namespace (e.g. per-user / per-tenant ' +
        'partition) that no current ownedNamespace covers. Hot-added namespaces support the same ' +
        'propose_type / propose_field surface as static ownedNamespaces.',
      "Reach for propose_type when the user describes a concept you don't see in the schema and an " +
        "owned namespace covers that domain (e.g. user asks you to 'track the books they lend out' " +
        'and `home` is an owned namespace).',
      'Reach for propose_field when an existing type needs a new attribute (additive) or a new edge ' +
        '(via a `crossRef` fieldSpec).',
      "DON'T propose for a one-off container — ask yourself if the concept is durable. A proposal " +
        'shipped into the typed store is a commitment.',
      "DON'T propose_type if the namespace is code-declared and outside ownedNamespaces. Propose " +
        'will reject with `unowned_namespace` — propose_namespace it first if appropriate.'
    ],
    mutations: {
      propose_namespace: {
        summary:
          'Hot-add a new namespace to the live engine without a restart. The new ns becomes ' +
          'immediately addressable by propose_type / propose_field. Recorded as a NamespaceProposal ' +
          `row in the \`${CONTROL_NAMESPACE}\` control-plane ns for audit + restart recovery.`,
        frameKey: `${CONTROL_NAMESPACE}/propose_namespace`,
        params: {
          ns: 'string — the new namespace name. Cannot be the reserved control-plane name.',
          proposedReason: 'string — short human-readable rationale'
        },
        returns: {
          id: 'uuid — the NamespaceProposal record id',
          ns: 'string',
          applied: 'boolean — true once the namespace is live in the engine',
          appliedAt: 'ISO-8601 datetime',
          proposedBy: 'string — the signed caller id; never taken from params',
          'proposedAt / proposedReason': 'when, and the echoed rationale',
          supersededByCode:
            'boolean — true when a later code deploy adds the same ns to static ownedNamespaces'
        }
      },
      propose_type: {
        summary: 'Create a new type + its autoCRUD surface in one atomic write.',
        frameKey: '<ns>/propose_type  where <ns> must be in ownedNamespaces',
        params: {
          typeName: 'string — PascalCase, unique within the namespace',
          fields:
            'object — FieldSpecJson map keyed by camelCase field name (see fieldSpecJson below)',
          proposedReason: 'string — short human-readable rationale'
        },
        returns: {
          id: 'uuid — the TypeProposal record id',
          typeName: 'string',
          applied: 'boolean — true once the type is live in the registry',
          appliedAt: 'ISO-8601 datetime',
          resultingSchemaVersion:
            'string — schemaVersion hash of the registry AFTER this proposal applied; null until applied',
          proposedBy: 'string — the signed caller id; never taken from params',
          'proposedAt / proposedReason': 'when, and the echoed rationale',
          supersededByCode: 'boolean — true when a later code deploy declared the same name'
        }
      },
      propose_field: {
        summary: 'Add one field to an existing type (code-declared or previously proposed).',
        frameKey: '<ns>/propose_field  where <ns> is the namespace containing targetType',
        params: {
          targetType: 'string — name of the type to extend',
          fieldName: 'string — new field, camelCase, unique on this type',
          fieldSpec: 'FieldSpecJson — single field; see variants below',
          proposedReason: 'string',
          valueMap:
            'optional — stranded source value → target value (null to knowingly strand). ' +
            'Only for enum narrowing: runs migrate-first-then-narrow. ' +
            'Without it, re-proposing an existing field with a different spec is refused.'
        },
        returns: {
          id: 'uuid — the FieldProposal record id',
          targetType: 'string',
          fieldName: 'string',
          applied: 'boolean',
          appliedAt: 'ISO-8601 datetime',
          resultingSchemaVersion:
            'string — schemaVersion hash of the registry AFTER this proposal applied; null until applied',
          valueMapJson: 'the supplied map as JSON, null when none',
          migration:
            'present only when the destructive path ran — { migrated, stranded, rowsScanned, truncated }'
        }
      }
    },
    fieldSpecJson: {
      description:
        'Narrow wire format mirroring the autoCRUD-expressible subset of FieldDef. Only these ' +
        'four shapes are accepted. Anything more expressive needs code + PR.',
      variants: {
        scalar: {
          shape:
            '{ kind: "scalar", type: "string"|"number"|"boolean"|"date"|"json", indexed?: bool, nullable?: bool }',
          notes:
            'indexed defaults to true for string/number/boolean/date, and is forced false for json (opaque body — no per-leaf filtering). readonly is reserved for engine-managed fields. ' +
            'Use type:"json" for arbitrary nested blobs you do not need to filter on (audit details, free-form metadata). ' +
            'Use kind:"struct" instead when you have a known nested shape and want per-field where-clause support.'
        },
        crossRef: {
          shape:
            '{ kind: "crossRef", ns: string, type: string, onDelete?: "set_null"|"cascade"|"restrict"|"orphan", indexed?: bool, nullable?: bool }',
          notes:
            'Use crossRef to declare an edge. Cross-namespace edges work when both ns values are in ' +
            'the plugin\'s ownedNamespaces. onDelete defaults to "set_null". For N:M, propose a join ' +
            'type with two crossRef fields — v2 does not model N:M natively.'
        },
        struct: {
          shape: '{ kind: "struct", fields: Record<string, FieldSpecJson>, nullable?: bool }',
          notes: 'Nested struct; each inner field is itself a FieldSpecJson.'
        },
        list: {
          shape: '{ kind: "list", of: FieldSpecJson, nullable?: bool }',
          notes:
            'Homogeneous list. For list-of-struct: { kind: "list", of: { kind: "struct", ... } }.'
        }
      }
    },
    constraints: [
      'AutoCRUD-only: every proposed type gets the standard create/get/update/delete/list surface. ' +
        'No custom resolvers — those require code.',
      'Additive, with one exception: propose_type rejects if the name exists; propose_field ' +
        'rejects with `destructive_change_required` if the field exists with a different spec, ' +
        'unless the change narrows an enum and a valueMap is supplied. That path rewrites every ' +
        'stored value the map names before narrowing, so it changes data, not just schema.',
      'First-past-the-post: concurrent proposes of the same name (namespace, type, or field) are ' +
        'serialised by a lock on that name — a schema-scoped advisory lock on a pg backend, a ' +
        'process-local lock otherwise. The first to take it wins; the next reads its row and gets ' +
        '`namespace_already_proposed` / `type_already_proposed` with the prior proposedBy/at in ' +
        'details, or, for a field with an identical spec, the prior FieldProposal row.',
      'Engine-injected fields: every proposed type gets a readonly+indexed `shortId: number` ' +
        'field auto-added by the plugin — callers must NOT declare shortId themselves.',
      'Proposals are first-class data: every NamespaceProposal / TypeProposal / FieldProposal is ' +
        `queryable as a normal type. NamespaceProposal lives in \`${CONTROL_NAMESPACE}\`; ` +
        'TypeProposal / FieldProposal live in their target namespace.',
      'Hot-added namespaces are first-class: a namespace created via propose_namespace supports ' +
        'the same propose_type / propose_field surface as a static ownedNamespace, and survives ' +
        'restarts via NamespaceProposal replay on cold boot.'
    ],
    collisions: {
      namespace_already_proposed:
        'A NamespaceProposal with this ns name already exists (non-archived). First-past-the-post — ' +
        'the prior proposer wins. Error details include `{ by, at }` from the prior proposal so the ' +
        'caller can decide whether to retry under a different name or proceed against the existing ns. ' +
        'Exception: if your own earlier propose_namespace for this ns failed part-way (its row is ' +
        'still applied=false), re-sending it under the same identity completes it instead.',
      namespace_retired:
        'This ns was proposed and later dropped. Its name stays reserved, because keys and invites ' +
        'grant namespaces by name and would otherwise reach a new namespace under the old one. Pick a different name.',
      invalid_namespace:
        `Reserved or malformed ns. The control-plane name (\`${CONTROL_NAMESPACE}\`) cannot be proposed; ` +
        'a name must match [A-Za-z0-9_-]+, and a namespace the host already installed is rejected. Pick a different name.',
      dataset_not_provisioned:
        'The host has not registered a dataset for the requested ns. propose_namespace will not ' +
        "auto-provision storage — backend selection is the host's responsibility. Ensure the " +
        'binary or embedding host wires `datasetFor(ns)` before calling.',
      type_already_proposed:
        'A TypeProposal with this typeName already exists in the namespace. Use propose_field to ' +
        'extend it; do not re-propose.',
      type_already_exists:
        'A code-declared type (or a previously-applied proposal) already owns this name. Same ' +
        'resolution path as above.',
      destructive_change_required:
        'A field of the same name exists on targetType with a different spec. This is a destructive ' +
        'change. Pick a different fieldName, or accept that evolving the shape ' +
        'needs code.',
      unknown_type: 'targetType is not registered. propose_type it first.',
      unowned_namespace:
        "Namespace isn't in this plugin instance's ownedNamespaces and has not been hot-added via " +
        'propose_namespace. Either propose_namespace it first, or accept that proposals are scoped ' +
        'per-deployment.',
      invalid_field_spec:
        'fieldSpec did not match one of the four allowed shapes (scalar / crossRef / struct / list), ' +
        'or a crossRef targets a type outside the namespaces this plugin owns. ' +
        'Check kind, nesting, type spellings and crossRef targets.',
      invalid_params:
        'A required param is missing or malformed: typeName / targetType / fieldName must match ' +
        '[A-Za-z_][A-Za-z0-9_]*, fields must be a non-empty object, proposedReason a string.'
    },
    examples: {
      addNewNamespace: {
        mutate: {
          [`${CONTROL_NAMESPACE}/propose_namespace`]: {
            params: {
              ns: 'home_user_42',
              proposedReason:
                'Provision per-user home namespace on demand — host has dataset wired.'
            },
            fields: { id: true, ns: true, applied: true, appliedAt: true }
          }
        }
      },
      addNewType: {
        mutate: {
          [`${ownedNamespaces[0] ?? '<ns>'}/propose_type`]: {
            params: {
              typeName: 'Dress',
              fields: {
                name: { kind: 'scalar', type: 'string' },
                size: { kind: 'scalar', type: 'string', nullable: true },
                color: { kind: 'scalar', type: 'string', nullable: true }
              },
              proposedReason: 'User asked to track dresses in their closet.'
            },
            fields: { id: true, typeName: true, applied: true }
          }
        }
      },
      addFieldToExistingType: {
        mutate: {
          [`${ownedNamespaces[0] ?? '<ns>'}/propose_field`]: {
            params: {
              targetType: 'Dress',
              fieldName: 'brand',
              fieldSpec: { kind: 'scalar', type: 'string', nullable: true },
              proposedReason: 'Extend Dress with brand — user mentioned Reformation.'
            },
            fields: { id: true, fieldName: true, applied: true }
          }
        }
      },
      addCrossNamespaceEdge: {
        mutate: {
          [`${ownedNamespaces[0] ?? '<ns>'}/propose_field`]: {
            params: {
              targetType: 'Dress',
              fieldName: 'owner',
              fieldSpec: {
                kind: 'crossRef',
                ns: 'household',
                type: 'Person',
                onDelete: 'set_null'
              },
              proposedReason: 'Link each Dress to its household owner.'
            },
            fields: { id: true, applied: true }
          }
        }
      }
    }
  };
}

export function registerOnboardRoute(
  router: PluginRouter,
  _ctx: PluginRouteContext,
  ownedNamespaces: ReadonlyArray<string>
): void {
  const body = buildOnboardBody(ownedNamespaces);
  const encoded = JSON.stringify(body);
  router.get(
    '/onboard',
    (): SubstrateResponse => ({
      status: 200,
      headers: JSON_HEADERS,
      body: encoded
    })
  );
}
