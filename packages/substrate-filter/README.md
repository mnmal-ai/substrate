# @mnmal-ai/substrate-filter

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface.

The where-clause language shared by every Substrate dataset.

Filters take the shape `where: { field: { op: value } }`, with `AND` / `OR` / `NOT` for nesting. This package holds the built-in operator sets (`eq`, `gt`, `between`, `in`, `contains`, …, by field kind), the in-process evaluator (`evaluateWhere`), JSON-path predicates for `field.json()` fields, cursor encoding for pagination, and the registry for extension operators such as recall's `embeddingSimilar`, which datasets pre-resolve before running the query.

Which operators a field accepts depends on its kind. Ask the server rather than memorising a list: namespace-scoped schema responses carry `operators` (by kind) and `extensionOperators`, and a refused operator names the field and its kind.

## Where it fits

Used by both datasets (`substrate-dataset-memory`, `substrate-dataset-pg`) and by `@mnmal-ai/substrate-core` when validating a query. Kernel plugins register custom operators through `filterOperators`, which ends up in this package's extension registry.

## More

- Spec: §5.2 (filter, orderBy, pagination), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
- Source: `packages/substrate-filter/src/`
