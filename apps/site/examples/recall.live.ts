// Run with `node apps/site/examples/recall.live.ts`. Needs `fastembed` installed where the
// embedder package resolves it, and downloads bge-base on first use. Writes a gitignored file.
import { normalise, runExample, writeTranscript } from './_harness.ts';
import { app } from './recall/namespace.ts';
import { steps } from './recall/steps.ts';

try {
  const t = normalise(
    await runExample({ name: 'recall', namespaces: [app], embedder: 'live' }, steps)
  );
  const failed = t.steps.filter(
    (s) => s.status !== 200 || JSON.stringify(s.response).includes('"errors"')
  );
  if (failed.length > 0) throw new Error(`steps failed: ${failed.map((s) => s.label).join('; ')}`);
  const file = new URL('./recall/output.live.json', import.meta.url);
  await writeTranscript(t, file.pathname);
  console.log(`wrote ${file.pathname}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
