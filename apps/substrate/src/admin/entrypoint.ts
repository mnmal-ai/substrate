import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Is the module at `moduleUrl` the process entrypoint?
 *
 * Compares REALPATHS. Node resolves symlinks when it builds `import.meta.url`
 * but `process.argv[1]` is whatever the caller typed, so a naive comparison is
 * false whenever the file is reached through a link — which is EVERY install
 * under pnpm, whose `node_modules/<pkg>` is a symlink into `.pnpm/`, and
 * therefore every operational invocation including the `.bin` shim.
 *
 * Getting this wrong means `main` never runs: the CLI prints nothing and
 * **exits 0**, so `substrate-admin revoke <kid>` reports success and leaves the
 * key live.
 */
export function isEntrypointPath(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1.length === 0) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // argv[1] may not exist on disk (a `node -e` run, a deleted file). Not the
    // entrypoint, and not an error worth surfacing from a predicate.
    return false;
  }
}
