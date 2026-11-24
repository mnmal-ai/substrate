import type { ActionDecl, NamespaceConfig } from '@mnmal-ai/substrate-types';

/**
 * Every `then` target is a declared update action whose other params all have
 * a default or are optional, and the `then` edges form no cycle. Throws at
 * compose time, where every namespace's actions are known.
 */
export function assertActionGraph(namespaces: ReadonlyMap<string, NamespaceConfig>): void {
  const actions = new Map<string, ActionDecl>();
  for (const [ns, cfg] of namespaces) {
    for (const [type, entry] of cfg.registry.all()) {
      for (const [name, decl] of Object.entries(entry.actions ?? {})) {
        actions.set(`${ns}/${type}.${name}`, decl);
        if (decl.mutation !== undefined && cfg.registry.get(decl.mutation)?.kind !== 'mutation') {
          throw new Error(`${ns}/${type}.${name}: '${decl.mutation}' is not a mutation of '${ns}'`);
        }
      }
    }
  }
  assertActionChains(actions);
}

/**
 * As `assertActionGraph`, over actions keyed `<ns>/<Type>.<name>`, for the
 * chains from the `from` keys only: the rest of `actions` is taken as already
 * checked, so a target it chains on to need not be present.
 */
export function assertActionChains(
  actions: ReadonlyMap<string, ActionDecl>,
  from: Iterable<string> = actions.keys()
): void {
  const starts = [...from];
  for (const key of starts) {
    for (const then of actions.get(key)?.then ?? []) {
      const target = actions.get(then.action);
      if (target === undefined) {
        throw new Error(`${key}: then target ${then.action} does not exist`);
      }
      if (target.kind === 'create') {
        throw new Error(`${key}: then target ${then.action} is a create action`);
      }
      for (const [param, p] of Object.entries(target.params ?? {})) {
        const optional = p.optional === true || ('default' in p && p.default !== undefined);
        if (!optional) {
          throw new Error(
            `${key}: then target ${then.action} needs param '${param}', which has no default`
          );
        }
      }
    }
  }

  // DFS over then edges, in declaration order; `path` is the active chain.
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (key: string): void => {
    const at = path.indexOf(key);
    if (at !== -1) {
      throw new Error(`action cycle: ${[...path.slice(at), key].join(' -> ')}`);
    }
    if (done.has(key)) return;
    path.push(key);
    for (const then of actions.get(key)?.then ?? []) visit(then.action);
    path.pop();
    done.add(key);
  };
  for (const key of starts) visit(key);
}
