/// <reference types="astro/client" />
import type { Transcript } from '../../examples/_harness.ts';

const DIR = '../../examples/';
const sources = import.meta.glob<string>('../../examples/*/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true
});
const outputs = import.meta.glob<Transcript>(
  ['../../examples/*/output.json', '../../examples/*/output.live.json'],
  { import: 'default', eager: true }
);

/**
 * An example's own source files by file name, and its transcript. A live run's output (written
 * at deploy) wins over the committed snapshot; an example with neither has no transcript.
 */
export function loadExample(name: string): {
  files: Record<string, string>;
  transcript: Transcript | null;
} {
  const dir = `${DIR}${name}/`;
  const files = Object.fromEntries(
    Object.entries(sources)
      .filter(([path]) => path.startsWith(dir))
      .map(([path, source]) => [path.slice(dir.length), source])
  );
  return {
    files,
    transcript: outputs[`${dir}output.live.json`] ?? outputs[`${dir}output.json`] ?? null
  };
}
