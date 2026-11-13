/** The oldest Node the binaries run on; matches `engines.node` in package.json. */
export const MIN_NODE_VERSION = '26.13.1';

/** Returns a refusal message when `version` (e.g. `process.versions.node`) is below the minimum, else null. */
export function nodeVersionRefusal(version: string): string | null {
  const have = version.split('.').map(Number);
  const want = MIN_NODE_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a > b) return null;
    if (a < b)
      return `substrate requires Node ${MIN_NODE_VERSION} or newer; this is Node ${version}`;
  }
  return null;
}

/**
 * The refusal for this runtime, or null. Bun is exempt: it reports a Node
 * compatibility version (24.x) that says nothing about its own security fixes.
 */
export function runtimeRefusal(versions: { node: string; bun?: string }): string | null {
  return versions.bun !== undefined ? null : nodeVersionRefusal(versions.node);
}

/** Exits the process with a refusal when the running Node is below the minimum. */
export function assertNodeVersion(): void {
  const refusal = runtimeRefusal(process.versions);
  if (refusal === null) return;
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}
