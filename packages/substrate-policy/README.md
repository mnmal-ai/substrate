# @mnmal-ai/substrate-policy

Internal: bundled into `@mnmal-ai/substrate` and not published; its public surface is `@mnmal-ai/substrate/sdk` (also re-exported from `@mnmal-ai/substrate/client`).

Declarative policy primitives and combinators for Substrate, plus the key and grant helpers auth is built on.

A policy is a function from the request context to a decision (`{ allow, reason?, obligations? }`). This package provides the building blocks so a plugin can state its rules as values rather than middleware:

- primitives: `allowAll`, `denyAll`, `allowVerbs`, `denyVerbs`, `requireIdentity`, `requireCapability`, `requireNamespace`
- combinators: `and`, `or`, `not`
- row filters: `row(predicate)`, which emits an obligation the engine applies to results

For example, "anyone may read, writes need an identity" or "this mutation needs the `substrate.propose` capability". It also holds the capability-grant model (`Grant`, `encodeGrant`, `intersectGrants`, …), admin-credential resolution, and agent-token providers.

## Where it fits

Used when declaring a namespace (`defineNamespace(..., { policy })` or per-type `policy`) and by the engine, which evaluates the composed policy for every frame. The same rules work against either dataset.

## More

- Spec: §4.4 (policy), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-policy/src/`
