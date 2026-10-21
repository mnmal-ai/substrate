# substrate-proposals

Built-in coordinator plugin for adding namespaces, types and fields to a running Substrate.

An authorised agent extends the live schema without a code deploy:

- `_system_proposals/propose_namespace` creates a namespace, immediately queryable and mutatable through autoCRUD;
- `<ns>/propose_type` adds a type, with the standard create/update/delete/list surface, to an owned namespace;
- `<ns>/propose_field` adds a field to an existing type.

Each proposal is stored as a record (`NamespaceProposal`, `TypeProposal`, `FieldProposal`), so the change history is auditable and proposals are replayed on boot. The proposer is recorded from the caller's signed identity, never from a param.

Changes are additive, with one exception: `propose_field` with a `valueMap` narrows an existing enum and first rewrites every stored value the map names. That path changes data as well as schema and cannot be undone by the plugin, so grant `substrate.propose` only to callers you would trust with a bulk update of the owned namespaces.

## Where it fits

Proposals is built into `@mnmal-ai/substrate`: it loads whenever the binary sits in `SUBSTRATE_PLUGIN_DIR`, and there is nothing to install. Its exports are available from `@mnmal-ai/substrate/proposals`. Every `propose_*` call requires the `substrate.propose` capability on the caller's identity; without it the policy answers `policy_denied`.

## Usage

Configure it in `<SUBSTRATE_PLUGIN_DIR>/substrate-proposals.config.json`. The defaults are `ownedNamespaces: []` and `proposeCapability: "substrate.propose"`. List the namespaces the plugin owns:

```json
{ "ownedNamespaces": ["sandbox"], "proposeCapability": "substrate.propose" }
```

The gate cannot be switched off, so proposing needs auth on and a key granted the capability.

## More

- The plugin's onboard document, with the full field grammar, collision codes and worked examples: `GET /substrate/v1/plugins/substrate-proposals/onboard` on a running instance
- Spec: §5.15, [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `plugins/substrate-proposals/src/`
