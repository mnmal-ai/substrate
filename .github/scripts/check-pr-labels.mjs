/**
 * PR-hygiene gate: every PR carries at least one Area label, exactly one Type
 * label, exactly one Priority label, and at least one assignee.
 *
 * Backs the `PR hygiene` GitHub Actions workflow; CONTRIBUTING.md describes the
 * labels. Type, Priority and Status are closed sets. Area is intentionally open: any
 * label that is not a Type, Priority, or Status label counts as an Area, so new
 * subsystem labels work without editing this file.
 *
 * CLI usage (in CI): reads `PR_LABELS` + `PR_ASSIGNEES` as JSON arrays from the
 * environment, prints a report, and exits non-zero on any violation.
 */

export const TYPE_LABELS = ['feat', 'fix', 'refactor', 'docs', 'test', 'infra'];
export const PRIORITY_LABELS = ['P0-critical', 'P1-high', 'P2-medium', 'P3-low'];
export const STATUS_LABELS = ['blocked', 'needs-review', 'ready-to-merge'];

/**
 * @param {{ labels: string[], assignees: string[] }} pr
 * @returns {{ ok: boolean, errors: string[], areas: string[], types: string[], priorities: string[] }}
 */
export function evaluatePrHygiene({ labels, assignees }) {
  const present = new Set(labels);
  const nonArea = new Set([...TYPE_LABELS, ...PRIORITY_LABELS, ...STATUS_LABELS]);

  const types = TYPE_LABELS.filter((l) => present.has(l));
  const priorities = PRIORITY_LABELS.filter((l) => present.has(l));
  const areas = labels.filter((l) => !nonArea.has(l));

  const errors = [];
  if (areas.length < 1) {
    errors.push(
      `Missing an Area label (need ≥1, the package the PR touches, named without the @mnmal-ai/ scope, or repo). See CONTRIBUTING.md.`
    );
  }
  if (types.length !== 1) {
    errors.push(
      `Need exactly one Type label (got ${types.length}${types.length ? `: ${types.join(', ')}` : ''}). One of: ${TYPE_LABELS.join(', ')}.`
    );
  }
  if (priorities.length !== 1) {
    errors.push(
      `Need exactly one Priority label (got ${priorities.length}${priorities.length ? `: ${priorities.join(', ')}` : ''}). One of: ${PRIORITY_LABELS.join(', ')}.`
    );
  }
  if (assignees.length < 1) {
    errors.push('PR must have at least one assignee.');
  }

  return { ok: errors.length === 0, errors, areas, types, priorities };
}

function parseJsonArrayEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array (got ${typeof parsed})`);
  }
  return parsed.map(String);
}

function main() {
  const labels = parseJsonArrayEnv('PR_LABELS');
  const assignees = parseJsonArrayEnv('PR_ASSIGNEES');
  const result = evaluatePrHygiene({ labels, assignees });

  process.stdout.write(`labels: [${labels.join(', ')}]\nassignees: [${assignees.join(', ')}]\n\n`);

  if (result.ok) {
    process.stdout.write('✅ PR hygiene OK — area + type + priority + assignee all present.\n');
    return;
  }

  process.stdout.write('❌ PR hygiene check failed:\n');
  for (const err of result.errors) {
    process.stdout.write(`  • ${err}\n`);
  }
  process.stdout.write(
    '\nA maintainer applies these; contributors without triage access can leave them:\n  gh pr edit <N> --add-assignee <login> --add-label "<area>,<type>,<priority>"\n'
  );
  process.exitCode = 1;
}

// Run as CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
