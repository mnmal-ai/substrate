# substrate-proposals

Built-in coordinator plugin for adding namespaces, types and fields to a running Substrate.

An authorised agent extends the live schema without a code deploy:

- `_system_proposals/propose_namespace` creates a namespace, immediately queryable and mutatable through autoCRUD;
- `<ns>/propose_type` adds a type, with the standard create/update/delete/list surface, to an owned namespace;
- `<ns>/propose_field` adds a field to an existing type;
- `_system_proposals/propose_action` coins an `act` word for an existing type, usually through `define` in a sketch.

Each proposal is stored as a record (`NamespaceProposal`, `TypeProposal`, `FieldProposal`), so the change history is auditable and proposals are replayed on boot. The proposer is recorded from the caller's signed identity, never from a param.

A proposed `crossRef` may target a type in the namespace it is proposed into, or one in another namespace the proposer can read: a type in a namespace the plugin owns, or any stored type the engine has registered, code-defined types included. `onDelete` on a target the plugin does not own is `set_null` (the default), `cascade` or `orphan`, never `restrict`. A proposal is refused when the target has no type, when the proposer cannot read its namespace (the same refusal whether or not the type exists), when the type is not stored (a virtual type such as `recall/Hit`), when it sits in the `_system_proposals` control plane, or when `restrict` is asked of a type the plugin does not own. A walk may follow the reference across namespaces when the caller can read both, so a reference to another namespace serves joins and aggregates as well as reads.

`TypeProposal` and `FieldProposal` rows written directly through the engine meet the same reference rules, checked against the writer under a row lock; an update that can make a row live is checked on the merged row. A write that drops or redefines a field or type with stored rows through a `FieldProposal` or `TypeProposal` needs the drop capability, as `drop_type` does. Deleting, archiving or unapplying a live `NamespaceProposal`, or renaming its `ns`, takes the namespace off at the next boot, so it needs the drop capability in that namespace when the namespace holds stored rows, as `drop_namespace` does. Making one live (un-archiving, applying or un-superseding it, renaming its `ns`, or creating it applied) needs the drop capability in the namespace it names whatever its rows, so a dropped namespace stays retired. So do archiving a proposal, which retires its name, any change to or delete of an archived one, whose `ns` never changes, and a second proposal for a name that already has one not archived. `propose_namespace` needs only the propose capability (the drop capability is `admin`, and the plugin config does not set it; a plugin created in code with `proposeCapability: ''` turns this drop gate off along with the propose gate), and `createFieldProposal` is gated. `updateMany` and `deleteMany` on proposal types are refused. On all three proposal types `proposedBy` is the signed caller; setting it on update is refused with `client_supplied_server_field`.

On Postgres a proposed field gets no column on the request path. It is `pending`: its values live in the row's jsonb, reads, filters and sorts answer as they will once it has a column, and an index over it serves no read until the promotion sweep gives it one (every `SUBSTRATE_PROMOTE_INTERVAL_MS`, default 6 hours, or now with `substrate-admin promote-fields`). See [Operator decisions](../../docs/operator-decisions.md#fields).

Changes are additive, with one exception: `propose_field` with a `valueMap` narrows an existing enum and first rewrites every stored value the map names. That path changes data as well as schema and cannot be undone by the plugin, so grant `substrate.propose` only to callers you would trust with a bulk update of the owned namespaces.

## Actions

`propose_type` takes an optional `actions` map beside `fields`, declared as code declares actions (`past`, `params`, `set`, `kind: 'create'`, `then`). They are published for every caller with the type, with no evidence period. A `then` target must be declared in code or born with a type, never a coined word. Archiving or rewriting a type that another type chains into is refused with `action_chained`.

Words for an existing type are coined with `define Type.name field=value …` in an `act` sketch (see [`docs/act.md`](../../docs/act.md#coining-actions)). A coined word is usable only by its proposer until 5 committed uses, at least an hour apart, promote it. Each is stored as an `ActionProposal` record in `_system_proposals`.

- **Opting an agent in.** Add `_system_proposals` with `mutate` to the agent's key, by invite or key patch. It also needs `mutate` on the namespace of the target type. Grant `read` on `_system_proposals` to operators only, because it shows every `ActionProposal` (target type, sketch and proposer) across namespaces.
- **Veto and retire.** Archive the `ActionProposal` record. This needs `admin` in the word's target namespace. Archiving a pending word vetoes it, and archiving a published one retires it. The name stays closed on that type. Other client writes to the record are refused.
- **Caps.** 10 published coined words per type, 20 pending per proposer per namespace, and a pending word lapses after 30 days unused.

## Where it fits

Proposals is built into `@mnmal-ai/substrate`: it loads whenever the binary sits in `SUBSTRATE_PLUGIN_DIR`, and there is nothing to install. Its exports are available from `@mnmal-ai/substrate/proposals`. Every `propose_*` call requires the `substrate.propose` capability on the caller's identity; without it the policy answers `policy_denied`.

## Usage

Configure it in `<SUBSTRATE_PLUGIN_DIR>/substrate-proposals.config.json`. The defaults are `ownedNamespaces: []` and `proposeCapability: "substrate.propose"`. List the namespaces the plugin owns:

```json
{ "ownedNamespaces": ["sandbox"], "proposeCapability": "substrate.propose" }
```

The gate cannot be switched off through the plugin config, so proposing needs auth on and a key granted the capability.

## More

- The plugin's onboard document, with the full field grammar, collision codes and worked examples: `GET /substrate/v1/plugins/substrate-proposals/onboard` on a running instance
- Spec: §5.15, [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `plugins/substrate-proposals/src/`
