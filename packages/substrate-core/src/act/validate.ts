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
      }
    }
  }

  for (const [from, decl] of actions) {
    for (const then of decl.then ?? []) {
      const target = actions.get(then.action);
      if (target === undefined) {
        throw new Error(`${from}: then target ${then.action} does not exist`);
      }
      if (target.kind === 'create') {
        throw new Error(`${from}: then target ${then.action} is a create action`);
      }
      for (const [param, p] of Object.entries(target.params ?? {})) {
        const optional = p.optional === true || ('default' in p && p.default !== undefined);
        if (!optional) {
          throw new Error(
            `${from}: then target ${then.action} needs param '${param}', which has no default`
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
  for (const key of actions.keys()) visit(key);
}
