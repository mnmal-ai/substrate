// Fails the build if a consumer bundling one named import from a public entry
// gets more than its budget: bundles each import alone with rolldown, as a
// consumer's bundler would (platform node, esm, node builtins external,
// third-party dependencies inlined), and compares the output's size.
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { rolldown } = await import(createRequire(import.meta.resolve('tsdown')).resolve('rolldown'));

// [entry, import, ceiling in bytes]. A ceiling is the measured size plus
// about 15%; msgpackr alone is ~95 KB, so a budget under that proves it gone.
const BUDGETS = [
  ['client', 'substrateFetch', 12_000],
  ['client', 'createH2Fetch', 12_000],
  ['client', 'grantCovers', 2_000],
  ['client', 'makeTokenProvider', 5_000],
  ['client', 'SubstrateClient', 215_000],
  ['pack', 'PACK_MIME', 1_000],
  ['pack', 'encodeEnvelope', 135_000],
  ['sdk', 'field', 16_000],
  ['sdk', 'defineNamespace', 125_000],
  ['recall', 'createRecallPlugin', 185_000],
  ['proposals', 'createProposalsPlugin', 255_000],
  ['testing', 'MemoryDataset', 155_000]
];

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const ENTRY = '\0size-entry';
const failures = [];
for (const [entry, name, ceiling] of BUDGETS) {
  const file = fileURLToPath(new URL(`../dist/${entry}.js`, import.meta.url));
  const bundle = await rolldown({
    input: ENTRY,
    platform: 'node',
    logLevel: 'silent',
    external: (id) => builtins.has(id),
    plugins: [
      {
        name: 'size-entry',
        resolveId: (id) => (id === ENTRY ? id : null),
        load: (id) =>
          id === ENTRY
            ? `import { ${name} } from ${JSON.stringify(file)}; console.log(${name});`
            : null
      }
    ]
  });
  const { output } = await bundle.generate({ format: 'esm', codeSplitting: false });
  await bundle.close();
  const size = output.reduce((n, o) => n + (o.type === 'chunk' ? o.code.length : 0), 0);
  if (size > ceiling)
    failures.push(`${entry}:${name} bundles to ${size} bytes (budget ${ceiling})`);
}
if (failures.length > 0) {
  console.error(`Entry size budgets exceeded:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
