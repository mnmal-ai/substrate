# @mnmal-ai/substrate-sdk

Internal: bundled into `@mnmal-ai/substrate` and not published; its public surface is `@mnmal-ai/substrate/sdk`.

Declare Substrate namespaces and types, with autoCRUD, as plain values.

`defineNamespace(name, types, opts?)` builds a namespace from a `{ TypeName: { fields } }` map. The field DSL (`field.string`, `field.number`, `field.boolean`, `field.date`, `field.enum`, `field.vocab`, `field.json`, `field.crossRef`, `field.struct`, `field.list`) shapes each field. Every type gets autoCRUD mutations (`create<Type>`, `update<Type>`, `delete<Type>`, …) and a list query, with policies from `@mnmal-ai/substrate-policy` deciding who may do what. No decorators and no build step: types are registered when the engine boots.

## Usage

```ts
import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

export const tasks = defineNamespace('tasks', {
  Task: {
    fields: {
      title: field.string(),
      status: field.enum(['open', 'done']),
      notes: field.string({ indexed: false, nullable: true }),
      dueAt: field.date({ nullable: true })
    }
  }
});
```

## Where it fits

Between `@mnmal-ai/substrate-types` (interfaces) and `@mnmal-ai/substrate-core` (the engine that consumes registered namespaces). Coordinator plugins such as `substrate-proposals` and `substrate-sentinel` use it to declare their namespaces.

## More

- [`docs/plugin-author-guide.md`](../../docs/plugin-author-guide.md)
- Spec: §4 (core primitives) and §5.1 (autoCRUD), [`docs/substrate-from-first-principles.md`](../../docs/substrate-from-first-principles.md)
